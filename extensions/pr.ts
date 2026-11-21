/**
 * /pr — show the GitHub PR attached to the current branch (like Copilot CLI's /pr).
 *
 *   /pr          show PR summary (title, state, review, checks, URL)
 *   /pr open     open the PR in the browser
 *   /pr checks   list individual checks
 *   /pr refresh  refresh the footer status
 *
 * Also keeps a "PR #123" footer status, refreshed on session start and after each agent run.
 * Requires the `gh` CLI to be installed and authenticated.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

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

function table(rows: [string, string][]): string {
	const w0 = Math.max(5, ...rows.map(([k]) => k.length));
	const w1 = Math.max(7, ...rows.map(([, v]) => [...v].length));
	const bar = (l: string, m: string, r: string) => `${l}${"─".repeat(w0 + 2)}${m}${"─".repeat(w1 + 2)}${r}`;
	const row = (k: string, v: string) => `│ ${k.padEnd(w0)} │ ${v}${" ".repeat(w1 - [...v].length)} │`;
	const out = [bar("┌", "┬", "┐"), row("Field", "Details")];
	for (const [k, v] of rows) out.push(bar("├", "┼", "┤"), row(k, v));
	out.push(bar("└", "┴", "┘"));
	return out.join("\n");
}

const link = (text: string, url: string) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;

const titleCase = (s: string) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase().replace(/_/g, " ") : s);

// Sorts last among footer statuses so the footer's "..." truncation cuts the PR title, not other statuses.
const STATUS_KEY = "zz-pr";

const FIELDS =
	"number,title,state,isDraft,url,headRefName,baseRefName,reviewDecision,mergeable,author,statusCheckRollup,additions,deletions,changedFiles,reviews,latestReviews,reviewRequests";

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


export default function (pi: ExtensionAPI) {
	pi.registerEntryRenderer("pr-card", (entry, _opts, theme) => {
		const { text, url, number } = entry.data as { text: string; url?: string; number?: number };
		let [title, ...rest] = String(text).split("\n");
		let body = rest.join("\n");
		if (url) {
			title = title.replace(`PR #${number}`, link(`PR #${number}`, url));
			body = body.replace(url, link(url, url));
		}
		return new Text(`${theme.bold(theme.fg("accent", title))}\n${body}`, 1, 0);
	});

	async function ghJSON<T>(ctx: ExtensionContext, args: string[]): Promise<{ data?: T; error?: string }> {
		const r = await pi.exec("gh", args, { cwd: ctx.cwd, timeout: 15000 });
		if (r.code !== 0) return { error: (r.stderr || r.stdout).trim() || `gh exited with code ${r.code}` };
		try {
			return { data: JSON.parse(r.stdout) as T };
		} catch (e) {
			return { error: `could not parse gh output: ${e}` };
		}
	}

	async function fetchPR(ctx: ExtensionContext): Promise<{ pr?: PR; error?: string }> {
		const direct = await ghJSON<PR>(ctx, ["pr", "view", "--json", FIELDS]);
		if (direct.data || !direct.error?.includes("no pull requests found")) return { pr: direct.data, error: direct.error };

		// gh only matches the branch's tracked remote (e.g. chmouel:branch); the PR may come from another fork
		// or the base repo itself, so search by branch name regardless of head owner.
		const b = await pi.exec("git", ["branch", "--show-current"], { cwd: ctx.cwd, timeout: 5000 });
		const branch = b.stdout.trim();
		if (b.code !== 0 || !branch) return { error: direct.error };
		for (const state of ["open", "all"]) {
			const list = await ghJSON<{ number: number }[]>(ctx, ["pr", "list", "--head", branch, "--state", state, "--limit", "1", "--json", "number"]);
			const num = list.data?.[0]?.number;
			if (num) {
				const v = await ghJSON<PR>(ctx, ["pr", "view", String(num), "--json", FIELDS]);
				return { pr: v.data, error: v.error };
			}
		}
		return { error: direct.error };
	}

	async function refreshStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		const { pr } = await fetchPR(ctx);
		if (!pr) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const t = ctx.ui.theme;
		const c = summarizeChecks(pr.statusCheckRollup ?? []);
		const icon = c.fail ? t.fg("error", "✗") : c.pending ? t.fg("warning", "●") : t.fg("success", "✓");
		const label = pr.isDraft ? "draft " : pr.state !== "OPEN" ? `${pr.state.toLowerCase()} ` : "";
		const n = (pr.statusCheckRollup ?? []).length;
		const sepDot = t.fg("dim", " · ");
		const parts: string[] = [`${icon} ${t.fg("dim", label)}${link(t.fg("accent", `PR #${pr.number}`), pr.url)}`];
		if (n) {
			const ciText = c.fail ? `${c.fail} failing` : c.pending ? `${c.pending} pending` : `${n} passing`;
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
		parts.push(pr.title);
		ctx.ui.setStatus(STATUS_KEY, parts.join(sepDot));
	}

	pi.on("session_start", async (_e, ctx) => {
		refreshStatus(ctx).catch(() => {});
	});
	pi.on("agent_end", async (_e, ctx) => {
		refreshStatus(ctx).catch(() => {});
	});

	pi.registerCommand("pr", {
		description: "Show the GitHub PR for the current branch (open | checks | refresh)",
		getArgumentCompletions: (prefix: string) =>
			["open", "checks", "refresh"]
				.filter((s) => s.startsWith(prefix.trim()))
				.map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			const sub = (args || "").trim();

			if (sub === "open") {
				const { pr, error } = await fetchPR(ctx);
				if (!pr) return ctx.ui.notify(error || "No PR for the current branch", "error");
				const r = await pi.exec("gh", ["pr", "view", pr.url, "--web"], { cwd: ctx.cwd, timeout: 15000 });
				if (r.code !== 0) ctx.ui.notify((r.stderr || "could not open browser").trim(), "error");
				return;
			}

			const { pr, error } = await fetchPR(ctx);
			if (!pr) {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.notify(error?.includes("no pull requests found") ? "No PR for the current branch" : `gh: ${error}`, "warning");
				return;
			}
			await refreshStatus(ctx);
			if (sub === "refresh") return;

			const checks = pr.statusCheckRollup ?? [];
			const c = summarizeChecks(checks);
			const lines: string[] = [];

			if (sub === "checks") {
				lines.push(`Checks for PR #${pr.number}:`);
				const icon = { pass: "✓", fail: "✗", pending: "●", skip: "-" };
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
				const rows: [string, string][] = [
					["State", pr.isDraft ? "Draft" : titleCase(pr.state)],
					["Branch", `\ue0a0 ${pr.headRefName} → ${pr.baseRefName}`],
					["URL", pr.url],
					["Changes", `+${pr.additions} / -${pr.deletions} across ${pr.changedFiles} files`],
					["Author", `@${pr.author?.login}`],
					["Reviews", reviews],
					["Mergeable", titleCase(pr.mergeable)],
					["CI Checks", ci],
				];
				if (c.fail) {
					const failed = checks.filter((ch) => checkResult(ch) === "fail").map((ch) => ch.name || ch.context || "?");
					rows.push(["Failed", failed.join(", ")]);
				}
				lines.push(`PR #${pr.number} — ${pr.title}`, "", table(rows));
			}

			pi.appendEntry("pr-card", { text: lines.join("\n"), url: pr.url, number: pr.number });
		},
	});
}
