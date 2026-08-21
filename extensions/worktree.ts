import { existsSync, writeFileSync } from "node:fs";
import { mkdir, rmdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

type Worktree = { path: string; branch?: string };
type Inspection = {
	repository: string;
	currentPath: string;
	remotes: string[];
	localBranches: string[];
	remoteBranches: string[];
	worktrees: Worktree[];
	defaultBranch?: string;
};

type ExistingChoice = { branch: string; source: "local" | "remote" };

export default function (pi: ExtensionAPI) {
	pi.registerCommand("worktree", {
		description: "Create or continue a Git worktree and switch Pi to it",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/worktree requires interactive TUI mode.", "error");
				return;
			}

			try {
				const intent = await getIntent(args, ctx);
				if (!intent) return;

				const inspection = await inspect(pi, ctx);
				if (!inspection.remotes.includes("origin")) {
					throw new Error("This workflow requires an origin remote.");
				}
				await runGit(pi, ctx, ["fetch", "--prune", "--", "origin"]);
				const refreshed = await inspect(pi, ctx);

				const mode = await ctx.ui.select("Worktree action", [
					"Continue an existing branch",
					"Create a new branch",
				]);
				if (!mode) return;

				if (mode === "Continue an existing branch") {
					await continueBranch(pi, ctx, refreshed, intent);
				} else {
					await createBranch(pi, ctx, refreshed, intent);
				}
			} catch (error) {
				ctx.ui.notify(formatError(error), "error");
			}
		},
	});
}

async function getIntent(args: string, ctx: ExtensionCommandContext): Promise<string | undefined> {
	const supplied = args.trim();
	if (supplied) return supplied;
	const intent = await ctx.ui.input("What change do you want to work on?", "Describe the change");
	return intent?.trim() || undefined;
}

async function continueBranch(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	inspection: Inspection,
	intent: string,
	preferredBranch?: string,
): Promise<void> {
	const choices = existingChoices(inspection);
	if (choices.length === 0) {
		ctx.ui.notify("No local or origin branches are available to continue.", "info");
		return;
	}

	let choice: ExistingChoice | undefined;
	if (preferredBranch) {
		choice = choices.find((candidate) => candidate.branch === preferredBranch);
		if (!choice) throw new Error(`Branch ${preferredBranch} is no longer available to continue.`);
	} else {
		const labels = choices.map((candidate) => `${candidate.branch} (${candidate.source === "local" ? "local" : "origin"})`);
		const selected = await ctx.ui.select("Branch to continue", labels);
		if (!selected) return;
		choice = choices[labels.indexOf(selected)];
		if (!choice) throw new Error("Selected branch could not be resolved.");
	}

	const occupied = inspection.worktrees.find((worktree) => worktree.branch === choice.branch);
	if (occupied) {
		if (occupied.path === inspection.currentPath) {
			ctx.ui.notify(`Already working in ${occupied.path} on ${choice.branch}.`, "info");
			return;
		}
		const approved = await ctx.ui.confirm(
			"Switch Pi worktree",
			`Branch: ${choice.branch}\nExisting worktree: ${occupied.path}\n\nSwitch Pi to this worktree?`,
		);
		if (!approved) return;
		const sourceStatus = await runGit(pi, ctx, ["status", "--short", "--branch"]);
		await switchToWorktree(
			ctx,
			occupied.path,
			choice.branch,
			`Switched Pi to ${occupied.path} (${choice.branch}).${sourceStatus ? `\nOriginal checkout status:\n${sourceStatus}` : ""}`,
		);
		return;
	}

	const target = await chooseTarget(ctx, inspection, choice.branch, intent);
	if (!target) return;
	await validateBranch(pi, ctx, choice.branch);
	await ensureTargetAvailable(pi, ctx, target, choice.branch, "existing");

	const source = choice.source === "local" ? choice.branch : `origin/${choice.branch}`;
	const action = choice.source === "local"
		? ["worktree", "add", "--", target, choice.branch]
		: ["worktree", "add", "--track", "-b", choice.branch, "--", target, source];
	const approved = await ctx.ui.confirm(
		"Create and switch worktree",
		`Intent: ${intent}\nBranch: ${choice.branch}\nUpstream: ${source}\nTarget: ${target}\n\n${formatGit(action)}\n\nContinue?`,
	);
	if (!approved) return;

	await applyAndSwitch(pi, ctx, target, choice.branch, "existing", action);
}

async function createBranch(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	inspection: Inspection,
	intent: string,
): Promise<void> {
	const generatedBranch = uniqueBranchSuggestion(intent, inspection);
	const branch = await editField(ctx, "New branch name", generatedBranch);
	if (!branch) return;
	await validateBranch(pi, ctx, branch);

	const latest = await inspect(pi, ctx);
	if (latest.localBranches.includes(branch) || latest.remoteBranches.includes(branch)) {
		await continueBranch(pi, ctx, latest, intent, branch);
		return;
	}

	const defaultBase = latest.defaultBranch ? `origin/${latest.defaultBranch}` : "";
	if (!defaultBase) {
		ctx.ui.notify("origin/HEAD is unavailable; enter an explicit base branch or commit.", "warning");
	}
	const base = await editField(ctx, "Base branch or commit", defaultBase);
	if (!base) return;
	await runGit(pi, ctx, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${base}^{commit}`]);

	const target = await chooseTarget(ctx, latest, branch, intent);
	if (!target) return;
	await ensureTargetAvailable(pi, ctx, target, branch, "new");

	const action = ["worktree", "add", "-b", branch, "--", target, base];
	const approved = await ctx.ui.confirm(
		"Create and switch worktree",
		`Intent: ${intent}\nNew branch: ${branch}\nBase: ${base}\nTarget: ${target}\n\n${formatGit(action)}\n\nContinue?`,
	);
	if (!approved) return;

	await applyAndSwitch(pi, ctx, target, branch, "new", action);
}

async function chooseTarget(
	ctx: ExtensionCommandContext,
	inspection: Inspection,
	branch: string,
	_intent: string,
): Promise<string | undefined> {
	const container = resolve(dirname(inspection.repository), `${basename(inspection.repository)}.worktrees`);
	const suggested = resolve(container, safeComponent(branch));
	const input = await editField(ctx, "Worktree path", suggested);
	if (!input) return undefined;
	return resolve(ctx.cwd, input);
}

async function editField(
	ctx: ExtensionCommandContext,
	title: string,
	prefill: string,
): Promise<string | undefined> {
	const value = await ctx.ui.editor(title, prefill);
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	if (trimmed.includes("\n") || trimmed.includes("\r")) {
		throw new Error(`${title} must be a single line.`);
	}
	return trimmed;
}

async function ensureTargetAvailable(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	target: string,
	branch: string,
	mode: "existing" | "new",
): Promise<void> {
	const latest = await inspect(pi, ctx);
	const occupied = latest.worktrees.find((worktree) => worktree.branch === branch);
	if (occupied) {
		throw new Error(`Branch ${branch} is already checked out at ${occupied.path}.`);
	}
	if (existsSync(target)) {
		throw new Error(`Target path already exists: ${target}`);
	}
	const localExists = latest.localBranches.includes(branch);
	const remoteExists = latest.remoteBranches.includes(branch);
	if (mode === "new" && (localExists || remoteExists)) {
		throw new Error(`Branch ${branch} now exists; refusing to create a competing branch.`);
	}
	if (mode === "existing" && !localExists && !remoteExists) {
		throw new Error(`Branch ${branch} no longer exists locally or on origin.`);
	}
}

async function applyAndSwitch(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	target: string,
	branch: string,
	mode: "existing" | "new",
	action: string[],
): Promise<void> {
	// Revalidate all mutable Git and filesystem state after confirmation.
	await ensureTargetAvailable(pi, ctx, target, branch, mode);

	const parent = dirname(target);
	const parentExisted = existsSync(parent);
	if (!parentExisted) await mkdir(parent, { recursive: true });
	try {
		await runGit(pi, ctx, action);
	} catch (error) {
		if (!parentExisted) await rmdir(parent).catch(() => undefined);
		throw error;
	}

	const verified = await inspect(pi, ctx);
	const worktree = verified.worktrees.find((item) => item.branch === branch && item.path === target);
	if (!worktree) {
		throw new Error(`Git completed, but could not verify ${branch} at ${target}.`);
	}
	const status = await runGit(pi, ctx, ["-C", target, "status", "--short", "--branch"]);
	const sourceStatus = await runGit(pi, ctx, ["status", "--short", "--branch"]);
	const upstream = await tryGit(pi, ctx, ["-C", target, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);

	try {
		await switchToWorktree(
			ctx,
			target,
			branch,
			`Worktree ready: ${target}\nBranch: ${branch}${upstream ? `\nUpstream: ${upstream}` : ""}${status ? `\n${status}` : ""}${sourceStatus ? `\nOriginal checkout status:\n${sourceStatus}` : ""}`,
		);
	} catch (error) {
		throw new Error(
			`Created and verified worktree ${target} on ${branch}, but Pi could not switch to it. ` +
				`The worktree was retained. ${formatError(error)}`,
		);
	}
}

async function switchToWorktree(
	ctx: ExtensionCommandContext,
	target: string,
	branch: string,
	message = `Switched Pi to ${target} (${branch}).`,
): Promise<void> {
	const targetSession = createTargetSession(ctx, target);
	const result = await ctx.switchSession(targetSession, {
		withSession: async (replacementCtx) => {
			replacementCtx.ui.notify(message, "info");
		},
	});
	if (result.cancelled) throw new Error(`Pi session switch was cancelled; prepared session retained at ${targetSession}.`);
}

function createTargetSession(ctx: ExtensionCommandContext, target: string): string {
	const source = ctx.sessionManager.getSessionFile();
	const activeLeaf = ctx.sessionManager.getLeafId();
	if (source && existsSync(source)) {
		const persisted = SessionManager.open(source);
		if (persisted.getLeafId() === activeLeaf) {
			const forked = SessionManager.forkFrom(source, target);
			const file = forked.getSessionFile();
			if (!file) throw new Error("Pi could not prepare a target worktree session.");
			return file;
		}
		if (activeLeaf !== null && !persisted.getEntry(activeLeaf)) {
			throw new Error("The active conversation branch is not present in the persisted session.");
		}
	}

	const session = SessionManager.create(target, undefined, { parentSession: source });
	const file = session.getSessionFile();
	const header = session.getHeader();
	if (!file || !header) throw new Error("Pi could not prepare a target worktree session.");
	const entries: readonly SessionEntry[] = ctx.sessionManager.getBranch();
	writeFileSync(file, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
		encoding: "utf8",
		flag: "wx",
		mode: 0o600,
	});
	const verified = SessionManager.open(file);
	if (verified.getCwd() !== target || verified.getLeafId() !== activeLeaf) {
		throw new Error("Pi could not verify the prepared target session.");
	}
	return file;
}

async function inspect(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<Inspection> {
	const repository = await runGit(pi, ctx, ["rev-parse", "--show-toplevel"]);
	const currentPath = resolve(repository);
	const remotes = lines(await runGit(pi, ctx, ["remote"]));
	const localBranches = await branchNames(pi, ctx, "refs/heads");
	const remoteBranches = await branchNames(pi, ctx, "refs/remotes/origin");
	const worktrees = parseWorktrees(await runGit(pi, ctx, ["worktree", "list", "--porcelain", "-z"]));
	const head = await tryGit(pi, ctx, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	return {
		repository: currentPath,
		currentPath,
		remotes,
		localBranches,
		remoteBranches,
		worktrees,
		defaultBranch: head?.replace(/^origin\//, ""),
	};
}

async function branchNames(pi: ExtensionAPI, ctx: ExtensionCommandContext, ref: string): Promise<string[]> {
	const output = await runGit(pi, ctx, ["for-each-ref", "--format=%(refname:short)%00%(symref)", ref]);
	return output.split("\n").flatMap((line) => {
		const [name, symref] = line.split("\0");
		if (!name || symref) return [];
		return [name.replace(/^origin\//, "")];
	}).sort();
}

function parseWorktrees(output: string): Worktree[] {
	return output.split("\0\0").flatMap((record) => {
		if (!record) return [];
		const fields = new Map(record.split("\0").map((field) => {
			const index = field.indexOf(" ");
			return index < 0 ? [field, ""] : [field.slice(0, index), field.slice(index + 1)];
		}));
		const path = fields.get("worktree");
		if (!path) return [];
		const ref = fields.get("branch");
		return [{ path: resolve(path), branch: ref?.replace("refs/heads/", "") }];
	});
}

function existingChoices(inspection: Inspection): ExistingChoice[] {
	const choices: ExistingChoice[] = [];
	for (const branch of inspection.localBranches) choices.push({ branch, source: "local" });
	for (const branch of inspection.remoteBranches) {
		if (!inspection.localBranches.includes(branch)) choices.push({ branch, source: "remote" });
	}
	return choices.sort((a, b) => a.branch.localeCompare(b.branch));
}

async function validateBranch(pi: ExtensionAPI, ctx: ExtensionCommandContext, branch: string): Promise<void> {
	await runGit(pi, ctx, ["check-ref-format", "--branch", branch]);
}

async function runGit(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string[]): Promise<string> {
	const result = await pi.exec("git", args, { cwd: ctx.cwd, timeout: 30_000 });
	if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
	return result.stdout.trim();
}

async function tryGit(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string[]): Promise<string | undefined> {
	const result = await pi.exec("git", args, { cwd: ctx.cwd, timeout: 30_000 });
	return result.code === 0 ? result.stdout.trim() || undefined : undefined;
}

function lines(value: string): string[] {
	return value ? value.split("\n").filter(Boolean) : [];
}

function safeComponent(value: string): string {
	return value.replace(/[\\/]+/g, "-").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[._-]+|[._-]+$/g, "") || "change";
}

const BRANCH_FILLER_WORDS = new Set([
	"a", "an", "and", "as", "at", "be", "based", "by", "do", "for", "from", "i", "in", "is", "it",
	"make", "of", "on", "please", "should", "that", "the", "this", "to", "use", "want", "with", "would",
]);

function branchSuggestion(intent: string): string {
	const words = intent
		.toLowerCase()
		.replace(/[’']/g, "")
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length > 1 && !BRANCH_FILLER_WORDS.has(word))
		.slice(0, 5);
	const concise = safeComponent(words.join("-"));
	return concise.slice(0, 48).replace(/[._-]+$/g, "") || "change";
}

function uniqueBranchSuggestion(intent: string, inspection: Inspection): string {
	const base = branchSuggestion(intent);
	const existing = new Set([...inspection.localBranches, ...inspection.remoteBranches]);
	if (!existing.has(base)) return base;
	for (let suffix = 2; ; suffix++) {
		const candidate = `${base}-${suffix}`;
		if (!existing.has(candidate)) return candidate;
	}
}

function formatGit(args: string[]): string {
	return `git ${args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}`;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
