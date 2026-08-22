import assert from "node:assert/strict";
import test from "node:test";
import {
	assertLocalBranchSafe,
	evaluateChecks,
	parsePrArgument,
	repositorySelector,
	type Check,
} from "../extensions/merge-pr/core.ts";

function check(bucket: string, state = bucket): Check {
	return { name: `${bucket}-check`, state, bucket };
}

test("evaluateChecks rejects an empty check list", () => {
	assert.deepEqual(evaluateChecks([]), { status: "none" });
});

test("evaluateChecks accepts passed and skipped checks", () => {
	assert.deepEqual(evaluateChecks([check("pass"), check("skipping")]), { status: "ready" });
});

test("evaluateChecks reports pending checks", () => {
	assert.deepEqual(evaluateChecks([check("pass"), check("pending")]), {
		status: "pending",
		pending: [check("pending")],
	});
});

test("evaluateChecks blocks failures, cancellations, and unknown buckets", () => {
	const blocked = [check("fail"), check("cancel"), check("mystery")];
	assert.deepEqual(evaluateChecks([check("pass"), ...blocked]), { status: "blocked", blocked });
});

test("assertLocalBranchSafe accepts a clean, fully pushed PR branch", () => {
	assert.doesNotThrow(() =>
		assertLocalBranchSafe({ branch: "feature", headSha: "abc", status: "" }, "feature", "abc"),
	);
});

test("assertLocalBranchSafe rejects local changes, another branch, or an unpushed SHA", () => {
	assert.throws(
		() => assertLocalBranchSafe({ branch: "feature", headSha: "abc", status: "?? local.txt" }, "feature", "abc"),
		/uncommitted or untracked/,
	);
	assert.throws(
		() => assertLocalBranchSafe({ branch: "other", headSha: "abc", status: "" }, "feature", "abc"),
		/current branch/,
	);
	assert.throws(
		() => assertLocalBranchSafe({ branch: "feature", headSha: "local", status: "" }, "feature", "pushed"),
		/does not match/,
	);
});

test("repositorySelector supports github.com and enterprise URLs", () => {
	assert.equal(repositorySelector("https://github.com/acme/widgets/pull/42"), "acme/widgets");
	assert.equal(repositorySelector("https://github.example.com/acme/widgets/pull/42"), "github.example.com/acme/widgets");
});

test("parsePrArgument accepts an omitted argument, number, or PR URL", () => {
	assert.equal(parsePrArgument("  "), undefined);
	assert.equal(parsePrArgument("42"), "42");
	assert.equal(parsePrArgument("https://github.com/acme/widgets/pull/42"), "https://github.com/acme/widgets/pull/42");
});

test("parsePrArgument rejects branches and extra arguments", () => {
	assert.throws(() => parsePrArgument("feature/test"));
	assert.throws(() => parsePrArgument("42 extra"));
	assert.throws(() => parsePrArgument("https://github.com/acme/widgets/issues/42"));
});
