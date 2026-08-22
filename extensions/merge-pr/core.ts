export type Check = {
	name: string;
	workflow?: string;
	state: string;
	bucket: string;
	link?: string;
};

export type CheckEvaluation =
	| { status: "none" }
	| { status: "pending"; pending: Check[] }
	| { status: "blocked"; blocked: Check[] }
	| { status: "ready" };

export type LocalBranchState = {
	branch: string;
	headSha: string;
	status: string;
};

const ACCEPTED_BUCKETS = new Set(["pass", "skipping"]);
const PENDING_BUCKETS = new Set(["pending"]);

export function evaluateChecks(checks: Check[]): CheckEvaluation {
	if (checks.length === 0) return { status: "none" };

	const blocked = checks.filter((check) => {
		const bucket = check.bucket.toLowerCase();
		return !ACCEPTED_BUCKETS.has(bucket) && !PENDING_BUCKETS.has(bucket);
	});
	if (blocked.length > 0) return { status: "blocked", blocked };

	const pending = checks.filter((check) => PENDING_BUCKETS.has(check.bucket.toLowerCase()));
	if (pending.length > 0) return { status: "pending", pending };

	return { status: "ready" };
}

export function assertLocalBranchSafe(
	local: LocalBranchState,
	expectedBranch: string,
	expectedSha: string,
): void {
	if (local.status) {
		throw new Error("The working tree has uncommitted or untracked changes.");
	}
	if (!local.branch) throw new Error("HEAD is detached; check out the pull request branch first.");
	if (local.branch !== expectedBranch) {
		throw new Error(`The current branch is ${local.branch}, but the pull request head is ${expectedBranch}.`);
	}
	if (local.headSha !== expectedSha) {
		throw new Error(
			`Local HEAD ${local.headSha} does not match the pushed pull request head ${expectedSha}. ` +
				"Push or synchronize the branch before merging.",
		);
	}
}

export function formatCheck(check: Check): string {
	const workflow = check.workflow ? ` / ${check.workflow}` : "";
	const link = check.link ? ` — ${check.link}` : "";
	return `${check.name}${workflow}: ${check.state} (${check.bucket})${link}`;
}

export function repositorySelector(prUrl: string): string {
	let url: URL;
	try {
		url = new URL(prUrl);
	} catch {
		throw new Error(`GitHub returned an invalid pull request URL: ${prUrl}`);
	}
	const [owner, repository] = url.pathname.split("/").filter(Boolean);
	if (!owner || !repository) throw new Error(`Could not determine the repository from ${prUrl}`);
	return url.hostname === "github.com" ? `${owner}/${repository}` : `${url.hostname}/${owner}/${repository}`;
}

export function parsePrArgument(args: string): string | undefined {
	const value = args.trim();
	if (!value) return undefined;
	if (/\s/.test(value)) throw new Error("Usage: /merge-pr [PR-number-or-URL]");
	if (/^\d+$/.test(value)) return value;
	try {
		const url = new URL(value);
		if (!/^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(url.pathname)) throw new Error();
		return value;
	} catch {
		throw new Error("Pull request must be a number or a GitHub pull request URL.");
	}
}
