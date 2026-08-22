import { BorderedLoader, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	assertLocalBranchSafe,
	evaluateChecks,
	formatCheck,
	parsePrArgument,
	repositorySelector,
	type Check,
	type LocalBranchState,
} from "./merge-pr/core.ts";

type PullRequest = {
	number: number;
	title: string;
	url: string;
	state: string;
	isDraft: boolean;
	baseRefName: string;
	headRefName: string;
	headRefOid: string;
	mergeable: string;
	mergeStateStatus: string;
	reviewDecision: string | null;
};

type Inspection = {
	pr: PullRequest;
	repository: string;
	local: LocalBranchState;
	checks: Check[];
};

type LoaderOutcome<T> =
	| { status: "ok"; value: T }
	| { status: "cancelled" }
	| { status: "error"; message: string };

const PR_FIELDS = [
	"number",
	"title",
	"url",
	"state",
	"isDraft",
	"baseRefName",
	"headRefName",
	"headRefOid",
	"mergeable",
	"mergeStateStatus",
	"reviewDecision",
].join(",");
const CHECK_FIELDS = "name,workflow,state,bucket,link";
const POLL_INTERVAL_MS = 10_000;

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("merge-pr", {
		description: "Wait for an existing PR's CI checks, then squash-merge it",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/merge-pr requires interactive TUI mode.", "error");
				return;
			}

			try {
				const target = parsePrArgument(args);
				const inspected = await withLoader(ctx, "Inspecting pull request...", (signal) =>
					inspectPullRequest(pi, ctx.cwd, target, signal),
				);
				if (inspected.status === "cancelled") {
					ctx.ui.notify("Pull request inspection cancelled.", "info");
					return;
				}
				if (inspected.status === "error") {
					ctx.ui.notify(inspected.message, "error");
					return;
				}

				const inspection = inspected.value;
				const initialChecks = evaluateChecks(inspection.checks);
				if (initialChecks.status === "none") {
					ctx.ui.notify(`PR #${inspection.pr.number} has no CI checks; it was not merged.`, "error");
					return;
				}
				if (initialChecks.status === "blocked") {
					ctx.ui.notify(
						`PR #${inspection.pr.number} already has blocking CI checks:\n${initialChecks.blocked.map(formatCheck).join("\n")}`,
						"error",
					);
					return;
				}

				const approved = await ctx.ui.confirm(
					"Monitor and squash-merge pull request",
					formatConfirmation(inspection),
				);
				if (!approved) {
					ctx.ui.notify("Merge cancelled before monitoring started.", "info");
					return;
				}

				const monitored = await withLoader(
					ctx,
					`Waiting for CI on PR #${inspection.pr.number} (Esc to cancel)...`,
					(signal) => monitorUntilReady(pi, ctx.cwd, inspection, signal),
				);
				if (monitored.status === "cancelled") {
					ctx.ui.notify(`Monitoring cancelled; PR #${inspection.pr.number} was not merged by this command.`, "warning");
					return;
				}
				if (monitored.status === "error") {
					ctx.ui.notify(`${monitored.message}\n\nThe pull request was not merged by this command.`, "error");
					return;
				}

				const merged = await withLoader(
					ctx,
					`Squash-merging PR #${inspection.pr.number}...`,
					(signal) => mergeConfirmedPullRequest(pi, ctx.cwd, inspection, signal),
					false,
				);
				if (merged.status === "error") {
					ctx.ui.notify(merged.message, "error");
					return;
				}
				if (merged.status === "cancelled") {
					ctx.ui.notify("Merge was interrupted; verify the pull request state on GitHub.", "error");
					return;
				}
				ctx.ui.notify(merged.value, "info");
			} catch (error) {
				ctx.ui.notify(formatError(error), "error");
			}
		},
	});
}

async function withLoader<T>(
	ctx: ExtensionCommandContext,
	message: string,
	operation: (signal: AbortSignal) => Promise<T>,
	cancellable = true,
): Promise<LoaderOutcome<T>> {
	return ctx.ui.custom<LoaderOutcome<T>>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, message, { cancellable });
		let settled = false;
		const finish = (outcome: LoaderOutcome<T>) => {
			if (settled) return;
			settled = true;
			done(outcome);
		};
		loader.onAbort = () => finish({ status: "cancelled" });
		operation(loader.signal)
			.then((value) => finish({ status: "ok", value }))
			.catch((error: unknown) => {
				if (loader.signal.aborted) finish({ status: "cancelled" });
				else finish({ status: "error", message: formatError(error) });
			});
		return loader;
	});
}

async function inspectPullRequest(
	pi: ExtensionAPI,
	cwd: string,
	target: string | undefined,
	signal: AbortSignal,
): Promise<Inspection> {
	const pr = await getPullRequest(pi, cwd, target, signal);
	validateInitialPullRequest(pr);
	const repository = repositorySelector(pr.url);
	const local = await getLocalBranchState(pi, cwd, signal);
	assertLocalBranchSafe(local, pr.headRefName, pr.headRefOid);
	const repo = await ghJson<{ squashMergeAllowed: boolean }>(
		pi,
		cwd,
		["repo", "view", repository, "--json", "squashMergeAllowed"],
		signal,
	);
	if (!repo.squashMergeAllowed) throw new Error(`Repository ${repository} does not allow squash merging.`);
	const checks = await getChecks(pi, cwd, pr.url, signal);
	return { pr, repository, local, checks };
}

async function monitorUntilReady(
	pi: ExtensionAPI,
	cwd: string,
	inspection: Inspection,
	signal: AbortSignal,
): Promise<void> {
	const expected = inspection.pr;
	while (true) {
		signal.throwIfAborted();
		const current = await getPullRequest(pi, cwd, expected.url, signal);
		validateIdentity(current, expected);
		const local = await getLocalBranchState(pi, cwd, signal);
		assertLocalBranchSafe(local, expected.headRefName, expected.headRefOid);

		const checks = await getChecks(pi, cwd, expected.url, signal);
		const evaluation = evaluateChecks(checks);
		if (evaluation.status === "none") throw new Error("CI checks disappeared while monitoring.");
		if (evaluation.status === "blocked") {
			throw new Error(`CI has blocking checks:\n${evaluation.blocked.map(formatCheck).join("\n")}`);
		}
		if (evaluation.status === "ready") return;
		await delay(POLL_INTERVAL_MS, signal);
	}
}

async function mergeConfirmedPullRequest(
	pi: ExtensionAPI,
	cwd: string,
	inspection: Inspection,
	signal: AbortSignal,
): Promise<string> {
	const expected = inspection.pr;
	const current = await getPullRequest(pi, cwd, expected.url, signal);
	validateIdentity(current, expected);
	const local = await getLocalBranchState(pi, cwd, signal);
	assertLocalBranchSafe(local, expected.headRefName, expected.headRefOid);
	const checks = await getChecks(pi, cwd, expected.url, signal);
	const evaluation = evaluateChecks(checks);
	if (evaluation.status !== "ready") {
		if (evaluation.status === "blocked") {
			throw new Error(`CI changed before merging:\n${evaluation.blocked.map(formatCheck).join("\n")}`);
		}
		throw new Error("CI is no longer fully complete; the pull request was not merged.");
	}
	validateBeforeMerge(current);

	const mergeResult = await pi.exec(
		"gh",
		["pr", "merge", expected.url, "--squash", "--match-head-commit", expected.headRefOid],
		{ cwd, signal, timeout: 30_000 },
	);
	const merged = await ghJson<{
		state: string;
		url: string;
		mergeCommit: { oid?: string } | null;
	}>(pi, cwd, ["pr", "view", expected.url, "--json", "state,url,mergeCommit"], signal);
	if (merged.state !== "MERGED") {
		const commandError = mergeResult.stderr.trim() || mergeResult.stdout.trim();
		if (mergeResult.code !== 0 && commandError) throw new Error(commandError);
		throw new Error(
			`GitHub accepted the merge command, but the PR remains ${merged.state.toLowerCase()} (possibly queued): ${merged.url}`,
		);
	}
	const mergeCommit = merged.mergeCommit?.oid ? `\nMerge commit: ${merged.mergeCommit.oid}` : "";
	return `PR #${expected.number} was squash-merged successfully.\n${merged.url}${mergeCommit}`;
}

async function getLocalBranchState(
	pi: ExtensionAPI,
	cwd: string,
	signal: AbortSignal,
): Promise<LocalBranchState> {
	const branch = await runGit(pi, cwd, ["branch", "--show-current"], signal);
	const headSha = await runGit(pi, cwd, ["rev-parse", "HEAD"], signal);
	const status = await runGit(pi, cwd, ["status", "--porcelain=v1", "--untracked-files=all"], signal);
	return { branch: branch.stdout.trim(), headSha: headSha.stdout.trim(), status: status.stdout.trim() };
}

async function getPullRequest(
	pi: ExtensionAPI,
	cwd: string,
	target: string | undefined,
	signal: AbortSignal,
): Promise<PullRequest> {
	const args = ["pr", "view"];
	if (target) args.push(target);
	args.push("--json", PR_FIELDS);
	return ghJson<PullRequest>(pi, cwd, args, signal);
}

async function getChecks(pi: ExtensionAPI, cwd: string, target: string, signal: AbortSignal): Promise<Check[]> {
	const result = await pi.exec("gh", ["pr", "checks", target, "--json", CHECK_FIELDS], {
		cwd,
		signal,
		timeout: 30_000,
	});
	const stdout = result.stdout.trim();
	if (stdout) {
		try {
			const parsed = JSON.parse(stdout) as unknown;
			if (Array.isArray(parsed)) return parsed as Check[];
		} catch {
			throw new Error("Could not parse CI checks returned by gh.");
		}
	}
	if (result.code !== 0) {
		const error = result.stderr.trim() || result.stdout.trim();
		if (error.toLowerCase().includes("no checks reported")) return [];
		throw new Error(error || "gh pr checks failed.");
	}
	return [];
}

async function ghJson<T>(
	pi: ExtensionAPI,
	cwd: string,
	args: string[],
	signal: AbortSignal,
): Promise<T> {
	const result = await runGh(pi, cwd, args, signal);
	try {
		return JSON.parse(result.stdout) as T;
	} catch {
		throw new Error(`Could not parse JSON returned by gh ${args.slice(0, 2).join(" ")}.`);
	}
}

async function runGit(
	pi: ExtensionAPI,
	cwd: string,
	args: string[],
	signal: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number }> {
	const result = await pi.exec("git", args, { cwd, signal, timeout: 30_000 });
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.slice(0, 2).join(" ")} failed.`);
	}
	return result;
}

async function runGh(
	pi: ExtensionAPI,
	cwd: string,
	args: string[],
	signal: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number }> {
	const result = await pi.exec("gh", args, { cwd, signal, timeout: 30_000 });
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `gh ${args.slice(0, 2).join(" ")} failed.`);
	}
	return result;
}

function validateInitialPullRequest(pr: PullRequest): void {
	if (pr.state !== "OPEN") throw new Error(`PR #${pr.number} is not open (${pr.state}).`);
	if (pr.isDraft) throw new Error(`PR #${pr.number} is a draft.`);
	if (!pr.headRefOid) throw new Error("GitHub did not report the pull request head SHA.");
}

function validateIdentity(current: PullRequest, expected: PullRequest): void {
	if (current.state !== "OPEN") throw new Error(`PR #${expected.number} is no longer open (${current.state}).`);
	if (current.isDraft) throw new Error(`PR #${expected.number} became a draft.`);
	if (current.headRefOid !== expected.headRefOid) throw new Error("The pull request head SHA changed while monitoring.");
	if (current.headRefName !== expected.headRefName || current.baseRefName !== expected.baseRefName) {
		throw new Error("The pull request base or head branch changed while monitoring.");
	}
}

function validateBeforeMerge(pr: PullRequest): void {
	if (pr.mergeable !== "MERGEABLE") throw new Error(`GitHub reports the PR as ${pr.mergeable.toLowerCase()}.`);
	if (pr.reviewDecision === "CHANGES_REQUESTED" || pr.reviewDecision === "REVIEW_REQUIRED") {
		throw new Error(`Reviews block merging (${pr.reviewDecision}).`);
	}
	if (pr.mergeStateStatus !== "CLEAN" && pr.mergeStateStatus !== "HAS_HOOKS") {
		throw new Error(`GitHub reports merge state ${pr.mergeStateStatus || "UNKNOWN"}.`);
	}
}

function formatConfirmation(inspection: Inspection): string {
	const { pr, repository, local, checks } = inspection;
	const checkLines = checks.map((check) => `• ${formatCheck(check)}`).join("\n");
	return [
		`Repository: ${repository}`,
		`PR: #${pr.number} ${pr.title}`,
		`URL: ${pr.url}`,
		`Base: ${pr.baseRefName}`,
		`Head: ${pr.headRefName}`,
		`Head SHA: ${pr.headRefOid}`,
		`Local branch: ${local.branch} (clean and fully pushed)`,
		"",
		"Current CI checks:",
		checkLines,
		"",
		"This authorizes waiting indefinitely and automatically squash-merging this exact SHA once all checks pass or skip. Any blocking check or PR change stops the workflow.",
	].join("\n");
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason ?? new Error("Cancelled"));
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, milliseconds);
		const abort = () => {
			clearTimeout(timer);
			reject(signal.reason ?? new Error("Cancelled"));
		};
		signal.addEventListener("abort", abort, { once: true });
	});
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
