/**
 * /pr — show the GitHub PR attached to the current branch (like Copilot CLI's /pr).
 *
 *   /pr          show PR summary (title, state, review, checks, URL)
 *   /pr open     open the PR in the browser
 *   /pr checks   list individual checks
 *   /pr refresh  refresh the footer status
 *
 * Also keeps a footer status for the current branch, refreshed every minute, after each agent
 * run, and when the git branch changes. A merged or closed PR stays visible for a day.
 *
 * Requires the `gh` CLI, installed and authenticated.
 * Refresh and retention behaviour was inspired by @narumitw/pi-github-pr.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink, Text } from "@earendil-works/pi-tui";
import { watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";

type Check = { name?: string; context?: string; status?: string; conclusion?: string; state?: string };
type PR = {
	number: number;
	title: string;
	state: string;
	isDraft: boolean;
	url: string;
	headRefName: string;
	baseRefName: string;
	reviewDecision: string;
	mergeable: string;
	author: { login: string };
	statusCheckRollup: Check[];
	additions: number;
	deletions: number;
	changedFiles: number;
	closedAt: string | null;
	mergedAt: string | null;
	reviews: { author: { login: string }; state: string }[];
	latestReviews: { author: { login: string }; state: string }[];
	reviewRequests: { login?: string; name?: string; slug?: string }[];
};

type Reviewer = { name: string; state: "approved" | "changes" | "commented" | "requested" | "dismissed" };

const BOT_ICONS: Record<string, string> = {
	copilot: "\uf4b8", // nf-oct-copilot
	"github-copilot": "\uf4b8",
};

const shortName = (login: string) => {
	const n = login.replace(/-pull-request-reviewer$/, "").replace(/\[bot\]$/, "");
	return BOT_ICONS[n.toLowerCase()] ?? n;
};

/** Latest state per reviewer; pending review requests (e.g. Copilot still reviewing) override older reviews. */
function reviewers(pr: PR): Reviewer[] {
	const map = new Map<string, Reviewer["state"]>();
	const states: Record<string, Reviewer["state"]> = {
		APPROVED: "approved",
		CHANGES_REQUESTED: "changes",
		COMMENTED: "commented",
		DISMISSED: "dismissed",
	};
	for (const r of pr.latestReviews ?? []) {
		const st = states[r.state];
		if (r.author?.login && st) map.set(shortName(r.author.login), st);
	}
	for (const rq of pr.reviewRequests ?? []) {
		const n = rq.login || rq.slug || rq.name;
		if (n) map.set(shortName(n), "requested");
	}
	return [...map].map(([name, state]) => ({ name, state }));
}

const REVIEW_ICON: Record<Reviewer["state"], string> = {
	approved: "\uf42e", // nf-oct-check_circle
	changes: "\uf52f", // nf-oct-file_diff
	commented: "\uf41f", // nf-oct-comment
	requested: "\uf43a", // nf-oct-clock
	dismissed: "\uf468", // nf-oct-circle_slash
};
const REVIEW_COLOR = { approved: "success", changes: "error", commented: "muted", requested: "warning", dismissed: "dim" } as const;

/** Drops control characters so a hostile PR title cannot drive the terminal. */
function plain(value: string): string {
	let out = "";
	for (const ch of value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")) {
		const cp = ch.codePointAt(0) ?? 0;
		if (cp > 0x1f && cp !== 0x7f) out += ch;
	}
	return out;
}

const link = (text: string, url: string): string => {
	const safeText = plain(text);
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return safeText;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return safeText;
	try {
		if (!getCapabilities().hyperlinks) return safeText;
	} catch {
		return safeText;
	}
	return hyperlink(safeText, plain(parsed.toString()));
};

// Value column wraps at this width so long lists (failed checks, reviewers) stay inside the border.
const CELL_MAX = 72;

function wrapCell(value: string, max: number): string[] {
	const lines: string[] = [];
	let cur = "";
	for (const word of value.split(" ")) {
		if (!cur) cur = word;
		else if ([...cur].length + 1 + [...word].length <= max) cur += ` ${word}`;
		else {
			lines.push(cur);
			cur = word;
		}
	}
	lines.push(cur);
	return lines;
}

type Row = [key: string, value: string, color?: string];

function table(t: ExtensionContext["ui"]["theme"], rows: Row[]): string {
	const cells = rows.map(([k, v, c]) => [k, wrapCell(v, CELL_MAX), c] as const);
	const w0 = Math.max(5, ...cells.map(([k]) => k.length));
	const w1 = Math.max(7, ...cells.flatMap(([, lines]) => lines.map((l) => [...l].length)));
	const paint = (text: string, color?: string) => (color ? t.fg(color as never, text) : text);
	const bar = (l: string, m: string, r: string) => t.fg("dim", `${l}${"─".repeat(w0 + 2)}${m}${"─".repeat(w1 + 2)}${r}`);
	const row = (k: string, lines: string[], color?: string) =>
		lines.map((v, i) => `│ ${t.fg("dim", (i === 0 ? k : "").padEnd(w0))} │ ${paint(v + " ".repeat(w1 - [...v].length), color)} │`);

	const out = [bar("┌", "┬", "┐"), ...row("Field", ["Details"])];
	for (const [k, lines, color] of cells) out.push(bar("├", "┼", "┤"), ...row(k, lines, color));
	out.push(bar("└", "┴", "┘"));
	return out.join("\n");
}

const titleCase = (s: string) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase().replace(/_/g, " ") : s);

// Sorts last among footer statuses so the footer's "..." truncation cuts the PR title, not other statuses.
const STATUS_KEY = "zz-pr";
const REFRESH_MS = 60_000;
const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;
const FIELDS =
	"number,title,state,isDraft,url,headRefName,baseRefName,reviewDecision,mergeable,author,statusCheckRollup,additions,deletions,changedFiles,closedAt,mergedAt,reviews,latestReviews,reviewRequests";

function checkResult(c: Check): "pass" | "fail" | "pending" | "skip" {
	const v = (c.conclusion || c.state || c.status || "").toUpperCase();
	if (["SUCCESS", "NEUTRAL"].includes(v)) return "pass";
	if (["SKIPPED", "CANCELLED", "STALE"].includes(v)) return "skip";
	if (["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(v)) return "fail";
	return "pending";
}

function summarizeChecks(checks: Check[]) {
	const counts = { pass: 0, fail: 0, pending: 0, skip: 0 };
	for (const c of checks) counts[checkResult(c)]++;
	return counts;
}

/** A merged or closed PR leaves the footer once the retention window is over. */
function stillWorthShowing(pr: PR, since: number): boolean {
	if (pr.state === "OPEN") return true;
	const at = Date.parse(pr.mergedAt || pr.closedAt || "");
	const started = Number.isFinite(at) ? at : since;
	return Date.now() - started < TERMINAL_RETENTION_MS;
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let inflight: AbortController | undefined;
	let watcher: FSWatcher | undefined;
	let watchedHead: string | undefined;
	let terminalSince: number | undefined;
	let generation = 0;
	// The fallback lookup below costs two gh calls per refresh; the resolved number survives per branch.
	let branchCache: { key: string; number: number } | undefined;

	pi.registerEntryRenderer("pr-card", (entry, _opts, theme) => {
		const { text, url, number, heading } = entry.data as { text: string; url?: string; number?: number; heading?: string };
		let head = heading ? theme.bold(theme.fg("accent", heading)) : "";
		if (url && head) head = head.replace(`PR #${number}`, link(`PR #${number}`, url));
		const body = url ? text.replace(url, link(url, url)) : text;
		return new Text(head ? `${head}\n${body}` : body, 1, 0);
	});

	async function ghJSON<T>(ctx: ExtensionContext, args: string[], signal?: AbortSignal): Promise<{ data?: T; error?: string }> {
		let r: Awaited<ReturnType<typeof pi.exec>>;
		try {
			r = await pi.exec("gh", args, { cwd: ctx.cwd, timeout: 15000, signal });
		} catch (e) {
			return { error: String(e) };
		}
		if (r.code !== 0) return { error: (r.stderr || r.stdout).trim() || `gh exited with code ${r.code}` };
		if (r.truncated) return { error: "gh output too large" };
		try {
			return { data: JSON.parse(r.stdout) as T };
		} catch (e) {
			return { error: `could not parse gh output: ${e}` };
		}
	}

	async function fetchPR(ctx: ExtensionContext, signal?: AbortSignal): Promise<{ pr?: PR; error?: string }> {
		const direct = await ghJSON<PR>(ctx, ["pr", "view", "--json", FIELDS], signal);
		if (direct.data || !direct.error?.includes("no pull requests found")) return { pr: direct.data, error: direct.error };
		// gh only matches the branch's tracked remote (e.g. chmouel:branch); the PR may come from another fork
		// or the base repo itself, so search by branch name regardless of head owner.
		let b: Awaited<ReturnType<typeof pi.exec>>;
		try {
			b = await pi.exec("git", ["branch", "--show-current"], { cwd: ctx.cwd, timeout: 5000, signal });
		} catch {
			return { error: direct.error };
		}
		const branch = b.stdout.trim();
		if (b.code !== 0 || !branch) return { error: direct.error };
		const cacheKey = `${ctx.cwd}\u0000${branch}`;
		if (branchCache?.key === cacheKey) {
			const cached = await ghJSON<PR>(ctx, ["pr", "view", String(branchCache.number), "--json", FIELDS], signal);
			if (cached.data) return { pr: cached.data };
			branchCache = undefined;
		}
		for (const state of ["open", "all"]) {
			const list = await ghJSON<{ number: number }[]>(
				ctx,
				["pr", "list", "--head", branch, "--state", state, "--limit", "1", "--json", "number"],
				signal,
			);
			const num = list.data?.[0]?.number;
			if (num) {
				const v = await ghJSON<PR>(ctx, ["pr", "view", String(num), "--json", FIELDS], signal);
				if (v.data) branchCache = { key: cacheKey, number: num };
				return { pr: v.data, error: v.error };
			}
		}
		return { error: direct.error };
	}

	function failureStatus(ctx: ExtensionContext, error: string | undefined) {
		const t = ctx.ui.theme;
		const msg = (error || "").toLowerCase();
		if (!msg) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		} else if (msg.includes("no pull requests found") || msg.includes("no open pull request")) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		} else if (/enoent|not found|no such file|executable/.test(msg)) {
			ctx.ui.setStatus(STATUS_KEY, t.fg("error", "gh missing"));
		} else if (/auth|login|token|credential/.test(msg)) {
			ctx.ui.setStatus(STATUS_KEY, t.fg("error", "gh not logged in"));
		} else {
			// Network hiccups and odd gh failures: keep the footer clean rather than nagging.
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	}

	async function refreshStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		inflight?.abort();
		const controller = new AbortController();
		inflight = controller;
		const { pr, error } = await fetchPR(ctx, controller.signal);
		if (controller.signal.aborted) return;

		if (!pr) {
			terminalSince = undefined;
			failureStatus(ctx, error);
			return;
		}

		if (pr.state === "OPEN") terminalSince = undefined;
		else if (terminalSince === undefined) terminalSince = Date.now();
		if (!stillWorthShowing(pr, terminalSince ?? Date.now())) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		const t = ctx.ui.theme;
		const checks = pr.statusCheckRollup ?? [];
		const c = summarizeChecks(checks);
		const icon = c.fail ? t.fg("error", "✗") : c.pending ? t.fg("warning", "●") : t.fg("success", "✓");
		const label = pr.isDraft ? "draft " : pr.state !== "OPEN" ? `${pr.state.toLowerCase()} ` : "";
		const sepDot = t.fg("dim", " · ");
		const parts: string[] = [`${icon} ${t.fg("dim", label)}${link(t.fg("accent", `PR #${pr.number}`), pr.url)}`];
		if (checks.length) {
			const ciText = c.fail ? `${c.fail} failing` : c.pending ? `${c.pending} pending` : `${checks.length} passing`;
			parts.push(t.fg(c.fail ? "error" : c.pending ? "warning" : "dim", ciText));
		}
		if (pr.reviewDecision === "APPROVED") parts.push(t.fg("success", "approved"));
		else if (pr.reviewDecision === "CHANGES_REQUESTED") parts.push(t.fg("error", "changes requested"));
		else if (pr.reviewDecision === "REVIEW_REQUIRED") parts.push(t.fg("dim", "review required"));
		const revs = reviewers(pr);
		if (revs.length)
			parts.push(revs.map((r) => t.fg(REVIEW_COLOR[r.state], `${REVIEW_ICON[r.state]} ${r.name}`)).join(" "));
		if (pr.mergeable === "CONFLICTING") parts.push(t.fg("error", "conflicts"));
		parts.push(`${t.fg("success", `+${pr.additions}`)}${t.fg("error", `-${pr.deletions}`)}`);
		parts.push(plain(pr.title));
		ctx.ui.setStatus(STATUS_KEY, parts.join(sepDot));
	}

	function schedule(ctx: ExtensionContext, gen = generation) {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			if (gen !== generation) return;
			void refreshStatus(ctx)
				.catch(() => {})
				.finally(() => {
					if (gen === generation) schedule(ctx, gen);
				});
		}, REFRESH_MS);
		timer.unref?.();
	}

	function stopTimers() {
		generation++;
		if (timer) clearTimeout(timer);
		timer = undefined;
		watcher?.close();
		watcher = undefined;
		watchedHead = undefined;
		inflight?.abort();
		inflight = undefined;
	}

	/** Refreshes as soon as the checked-out branch changes, without waiting for the poll. */
	async function watchHead(ctx: ExtensionContext) {
		let r: Awaited<ReturnType<typeof pi.exec>>;
		try {
			r = await pi.exec("git", ["rev-parse", "--git-path", "HEAD"], { cwd: ctx.cwd, timeout: 5000 });
		} catch {
			return;
		}
		if (r.code !== 0) return;
		const head = resolve(ctx.cwd, r.stdout.trim());
		if (head === watchedHead) return;
		watcher?.close();
		watchedHead = head;
		try {
			let debounce: ReturnType<typeof setTimeout> | undefined;
			watcher = watch(head, () => {
				if (debounce) clearTimeout(debounce);
				debounce = setTimeout(() => {
					refreshStatus(ctx).catch(() => {});
				}, 300);
				debounce.unref?.();
			});
			watcher.on("error", () => {
				watcher?.close();
				watcher = undefined;
				watchedHead = undefined;
			});
			watcher.unref?.();
		} catch {
			watcher = undefined;
			watchedHead = undefined;
		}
	}

	pi.on("session_start", async (_e, ctx) => {
		stopTimers();
		terminalSince = undefined;
		branchCache = undefined;
		await watchHead(ctx);
		refreshStatus(ctx).catch(() => {});
		schedule(ctx);
	});

	pi.on("agent_end", async (_e, ctx) => {
		refreshStatus(ctx).catch(() => {});
	});

	pi.on("session_shutdown", async () => {
		stopTimers();
	});

	pi.registerCommand("pr", {
		description: "Show the GitHub PR for the current branch (open | checks | refresh)",
		getArgumentCompletions: (prefix: string) =>
			["open", "checks", "refresh"]
				.filter((s) => s.startsWith(prefix.trim()))
				.map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			const t = ctx.ui.theme;
			const sub = (args || "").trim();

			if (sub === "open") {
				const { pr, error } = await fetchPR(ctx);
				if (!pr) return ctx.ui.notify(error || "No PR for the current branch", "error");
				let r: Awaited<ReturnType<typeof pi.exec>>;
				try {
					r = await pi.exec("gh", ["pr", "view", pr.url, "--web"], { cwd: ctx.cwd, timeout: 15000 });
				} catch (e) {
					return ctx.ui.notify(String(e), "error");
				}
				if (r.code !== 0) ctx.ui.notify((r.stderr || "could not open browser").trim(), "error");
				return;
			}

			const { pr, error } = await fetchPR(ctx);
			if (!pr) {
				failureStatus(ctx, error);
				ctx.ui.notify(error?.includes("no pull requests found") ? "No PR for the current branch" : `gh: ${error}`, "warning");
				return;
			}
			await refreshStatus(ctx);
			if (sub === "refresh") return;

			const checks = pr.statusCheckRollup ?? [];
			const c = summarizeChecks(checks);
			const lines: string[] = [];

			if (sub === "checks") {
				const icon = { pass: t.fg("success", "✓"), fail: t.fg("error", "✗"), pending: t.fg("warning", "●"), skip: t.fg("dim", "-") };
				for (const ch of checks) lines.push(`  ${icon[checkResult(ch)]} ${ch.name || ch.context}`);
				if (!checks.length) lines.push("  (no checks)");
			} else {
				const revs = reviewers(pr);
				let reviews = revs.length ? revs.map((r) => `${REVIEW_ICON[r.state]} ${r.name} (${r.state})`).join(", ") : "None";
				if (pr.reviewDecision) reviews += ` · ${titleCase(pr.reviewDecision)}`;
				let ci: string;
				if (!checks.length) ci = "No checks";
				else if (c.pass === checks.length) ci = `All ${checks.length} passing`;
				else {
					const parts = [`${c.pass} passing`];
					if (c.fail) parts.push(`${c.fail} failing`);
					if (c.pending) parts.push(`${c.pending} pending`);
					if (c.skip) parts.push(`${c.skip} skipped`);
					ci = parts.join(", ");
				}
				const stateColor = pr.isDraft ? "warning" : pr.state === "OPEN" ? "success" : pr.state === "MERGED" ? "accent" : "error";
				const ciColor = !checks.length ? "dim" : c.fail ? "error" : c.pending ? "warning" : "success";
				const reviewColor = revs.some((r) => r.state === "changes")
					? "error"
					: revs.length && revs.every((r) => r.state === "approved")
						? "success"
						: "dim";
				const mergeColor = pr.mergeable === "CONFLICTING" ? "error" : pr.mergeable === "MERGEABLE" ? "success" : "warning";
				const rows: Row[] = [
					["State", pr.isDraft ? "Draft" : titleCase(pr.state), stateColor],
					["Branch", `\ue0a0 ${pr.headRefName} → ${pr.baseRefName}`, "accent"],
					["URL", pr.url, "accent"],
					["Changes", `+${pr.additions} / -${pr.deletions} across ${pr.changedFiles} files`],
					["Author", `@${pr.author?.login}`],
					["Reviews", reviews, reviewColor],
					["Mergeable", titleCase(pr.mergeable), mergeColor],
					["CI Checks", ci, ciColor],
				];
				if (c.fail) {
					const failed = checks.filter((ch) => checkResult(ch) === "fail").map((ch) => ch.name || ch.context || "?");
					rows.push(["Failed", failed.join(", "), "error"]);
				}
				lines.push("", table(t, rows));
			}
			const heading = sub === "checks" ? `Checks for PR #${pr.number}` : `PR #${pr.number} — ${plain(pr.title)}`;
			pi.appendEntry("pr-card", { text: lines.join("\n"), url: pr.url, number: pr.number, heading });
		},
	});
}
