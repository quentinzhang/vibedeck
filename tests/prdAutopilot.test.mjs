import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
	buildWorkerPrompt,
	detectBaseBranch,
	deriveFinalStatusFromResult,
	ensureWorktree,
	formatResultMarkdown,
	hasLiveWorker,
	getCommitGateIssues,
	getPullRequestGateIssues,
	normalizeWorkerResult,
	parseCreatePullRequestRequirement,
	reconcileOnce,
	resolveDispatchAgentInvoke,
	resolveWorkerResultSchema,
	validateWorkerResultShape,
} from '../scripts/prd-autopilot/prd_autopilot.mjs';
import { execFileSync } from 'node:child_process';

function sampleResult(overrides = {}) {
	return {
		outcome: 'in-review',
		summary: 'Implemented the requested card',
		blockers: [],
		validation: [{ command: 'npm test', ok: true, notes: 'all green' }],
		files_changed: ['src/app.ts'],
		commit: {
			created: true,
			message: 'feat: complete card',
			sha: 'abc1234',
			branch: 'vbd/demo/FEAT-0001',
		},
		pull_request: {
			created: false,
			url: '',
			number: '',
			branch: '',
			base_branch: '',
		},
		notes: 'Committed after validation.',
		...overrides,
	};
}

test('buildWorkerPrompt requires commit delivery on the assigned branch', () => {
	const prompt = buildWorkerPrompt({
		hubRoot: '/hub',
		project: 'demo',
		repoPath: '/repo',
		worktreePath: '/repo/.worktrees/demo/FEAT-0001',
		branchName: 'vbd/demo/FEAT-0001',
		cardId: 'FEAT-0001',
		cardText: 'Ship it',
		resultPath: '/repo/.prd-autopilot/results/demo-FEAT-0001.json',
		schemaPath: '/repo/scripts/prd-autopilot/assets/result.schema.json',
		logPath: '/repo/.prd-autopilot/results/demo-FEAT-0001.log',
		createPullRequest: false,
		agent: 'codex',
		agentInvoke: 'exec',
	});

	assert.match(prompt, /Assigned branch: vbd\/demo\/FEAT-0001/);
	assert.match(prompt, /outcome: "in-review" ONLY if you implemented, validated, and committed/i);
	assert.match(prompt, /git status --short/);
	assert.match(prompt, /report commit\.created, commit\.message, commit\.sha, and commit\.branch/i);
	assert.match(prompt, /Create pull request on success: optional/);
	assert.match(prompt, /Pull request creation is optional for this run/i);
});

test('buildWorkerPrompt can require pull request delivery', () => {
	const prompt = buildWorkerPrompt({
		hubRoot: '/hub',
		project: 'demo',
		repoPath: '/repo',
		worktreePath: '/repo/.worktrees/demo/FEAT-0001',
		branchName: 'vbd/demo/FEAT-0001',
		cardId: 'FEAT-0001',
		cardText: 'Ship it',
		resultPath: '/repo/.prd-autopilot/results/demo-FEAT-0001.json',
		schemaPath: '/repo/scripts/prd-autopilot/assets/result.schema.json',
		logPath: '/repo/.prd-autopilot/results/demo-FEAT-0001.log',
		createPullRequest: true,
		agent: 'codex',
		agentInvoke: 'exec',
	});

	assert.match(prompt, /Create pull request on success: required/);
	assert.match(prompt, /REQUIRES a pull request after the commit succeeds/i);
	assert.match(prompt, /report pull_request\.created, pull_request\.url/i);
});

test('buildWorkerPrompt adapts interactive instructions for Claude Code', () => {
	const prompt = buildWorkerPrompt({
		hubRoot: '/hub',
		project: 'demo',
		repoPath: '/repo',
		worktreePath: '/repo/.worktrees/demo/FEAT-0001',
		branchName: 'vbd/demo/FEAT-0001',
		cardId: 'FEAT-0001',
		cardText: 'Ship it',
		resultPath: '/repo/.prd-autopilot/results/demo-FEAT-0001.json',
		schemaPath: '/repo/scripts/prd-autopilot/assets/result.schema.json',
		logPath: '/repo/.prd-autopilot/results/demo-FEAT-0001.log',
		createPullRequest: false,
		agent: 'claude',
		agentInvoke: 'prompt',
	});

	assert.match(prompt, /Coding agent: Claude Code/);
	assert.match(prompt, /Agent invoke: prompt/);
	assert.match(prompt, /IMPORTANT \(interactive mode\): Claude Code cannot auto-save your last message/i);
	assert.match(prompt, /persist the same FINAL JSON object to the file path in "Result JSON path"/i);
	assert.match(prompt, /write_result_json\.mjs/);
	assert.match(prompt, /PRD_AUTOPILOT_RESULT_WRITER/);
});


test('buildWorkerPrompt avoids separate prose summary instructions for Claude exec mode', () => {
	const prompt = buildWorkerPrompt({
		hubRoot: '/hub',
		project: 'demo',
		repoPath: '/repo',
		worktreePath: '/repo/.worktrees/demo/FEAT-0001',
		branchName: 'vbd/demo/FEAT-0001',
		cardId: 'FEAT-0001',
		cardText: 'Ship it',
		resultPath: '/repo/.prd-autopilot/results/demo-FEAT-0001.json',
		schemaPath: '/repo/scripts/prd-autopilot/assets/result.schema.json',
		logPath: '/repo/.prd-autopilot/results/demo-FEAT-0001.log',
		createPullRequest: false,
		agent: 'claude',
		agentInvoke: 'exec',
	});

	assert.match(prompt, /Agent invoke: exec/);
	assert.match(prompt, /This run is non-interactive; do NOT emit a separate prose summary before the FINAL JSON/i);
	assert.match(prompt, /Return ONLY the JSON object/i);
	assert.match(prompt, /Put the human-readable summary in the FINAL JSON "notes" field/i);
	assert.doesNotMatch(prompt, /IMPORTANT \(interactive mode\)/i);
});

test('resolveDispatchAgentInvoke defaults Claude process runs to exec', () => {
	assert.equal(resolveDispatchAgentInvoke('', { agent: 'claude', runner: 'process' }), 'exec');
	assert.equal(resolveDispatchAgentInvoke('', { agent: 'claude', runner: 'tmux' }), 'prompt');
	assert.equal(resolveDispatchAgentInvoke('prompt', { agent: 'claude', runner: 'process' }), 'prompt');
	assert.equal(resolveDispatchAgentInvoke('', { agent: 'codex', runner: 'process' }), 'exec');
});

test('detectBaseBranch handles unborn HEAD repositories', async () => {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vbd-unborn-head-'));
	const repoPath = path.join(tmp, 'repo');

	execFileSync('git', ['init', repoPath], { encoding: 'utf8', stdio: 'ignore' });

	assert.equal(detectBaseBranch(repoPath), 'main');
});

test('ensureWorktree creates an orphan worktree for repositories without commits', async () => {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vbd-unborn-worktree-'));
	const repoPath = path.join(tmp, 'repo');

	execFileSync('git', ['init', repoPath], { encoding: 'utf8', stdio: 'ignore' });

	const { worktreePath, branchName, existed } = ensureWorktree({
		repoPath,
		project: 'demo',
		cardId: 'FEAT-0001',
		worktreeBaseDir: '',
		baseBranch: '',
		dryRun: false,
	});

	assert.equal(existed, false);
	assert.equal(branchName, 'vbd/demo/FEAT-0001');
	const status = execFileSync('git', ['-C', worktreePath, 'status', '--short', '--branch'], { encoding: 'utf8' });
	assert.match(status, /No commits yet on vbd\/demo\/FEAT-0001/);
});

test('resolveWorkerResultSchema prefers the vibedeck-worker hub fallback', async () => {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vbd-schema-fallback-'));
	const hubRoot = path.join(tmp, 'hub');
	const worktreePath = path.join(tmp, 'repo', '.worktrees', 'demo', 'FEAT-0001');
	const fallbackSchema = path.join(hubRoot, 'skills', 'vibedeck-worker', 'assets', 'result.schema.json');

	await fs.mkdir(worktreePath, { recursive: true });
	await fs.mkdir(path.dirname(fallbackSchema), { recursive: true });
	await fs.writeFile(fallbackSchema, '{}', 'utf8');

	const resolved = await resolveWorkerResultSchema({ worktreePath, hubRoot });

	assert.equal(resolved.schemaAbs, fallbackSchema);
	assert.equal(resolved.hubSchemaCandidates[0], fallbackSchema);
	assert.match(resolved.hubSchemaCandidates[1], /skills[\\/]prd-worker[\\/]assets[\\/]result\.schema\.json$/);
});

test('resolveWorkerResultSchema still supports the legacy prd-worker fallback', async () => {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vbd-schema-legacy-'));
	const hubRoot = path.join(tmp, 'hub');
	const worktreePath = path.join(tmp, 'repo', '.worktrees', 'demo', 'FEAT-0001');
	const legacySchema = path.join(hubRoot, 'skills', 'prd-worker', 'assets', 'result.schema.json');

	await fs.mkdir(worktreePath, { recursive: true });
	await fs.mkdir(path.dirname(legacySchema), { recursive: true });
	await fs.writeFile(legacySchema, '{}', 'utf8');

	const resolved = await resolveWorkerResultSchema({ worktreePath, hubRoot });

	assert.equal(resolved.schemaAbs, legacySchema);
	assert.match(resolved.hubSchemaCandidates[0], /skills[\\/]vibedeck-worker[\\/]assets[\\/]result\.schema\.json$/);
	assert.equal(resolved.hubSchemaCandidates[1], legacySchema);
});

test('validateWorkerResultShape requires commit and pull request fields when marked created', () => {
	const valid = validateWorkerResultShape(sampleResult());
	assert.equal(valid.ok, true);

	const invalid = validateWorkerResultShape(sampleResult({
		commit: { created: true, message: 'feat: complete card', sha: '', branch: '' },
		pull_request: { created: true, url: '', number: '', branch: '', base_branch: '' },
	}));
	assert.equal(invalid.ok, false);
	assert.match(invalid.errors.join('\n'), /commit\.sha/);
	assert.match(invalid.errors.join('\n'), /commit\.branch/);
	assert.match(invalid.errors.join('\n'), /pull_request\.url/);
	assert.match(invalid.errors.join('\n'), /pull_request\.branch/);
	assert.match(invalid.errors.join('\n'), /pull_request\.base_branch/);
});

test('deriveFinalStatusFromResult blocks in-review outcomes without commit evidence', () => {
	const missingCommit = sampleResult({
		commit: { created: false, message: '', sha: '', branch: '' },
	});

	assert.deepEqual(getCommitGateIssues(missingCommit), ['Worker did not create a commit']);
	assert.equal(deriveFinalStatusFromResult(missingCommit), 'blocked');
	assert.equal(deriveFinalStatusFromResult(sampleResult({ outcome: 'blocked' })), 'blocked');
	assert.equal(deriveFinalStatusFromResult(sampleResult()), 'in-review');
});

test('deriveFinalStatusFromResult blocks in-review outcomes without required pull request evidence', () => {
	const missingPullRequest = sampleResult();

	assert.deepEqual(getPullRequestGateIssues(missingPullRequest, { requirePullRequest: true }), ['Worker did not create a pull request']);
	assert.equal(deriveFinalStatusFromResult(missingPullRequest, { requirePullRequest: true }), 'blocked');
	assert.equal(
		deriveFinalStatusFromResult(sampleResult({
			pull_request: {
				created: true,
				url: 'https://example.test/pr/42',
				number: '42',
				branch: 'vbd/demo/FEAT-0001',
				base_branch: 'main',
			},
		}), { requirePullRequest: true }),
		'in-review',
	);
});

test('normalizeWorkerResult downgrades malformed commit payloads to blocked result', () => {
	const normalized = normalizeWorkerResult(sampleResult({
		commit: { created: true, message: 'feat: complete card', sha: '', branch: '' },
	}));

	assert.equal(normalized.outcome, 'blocked');
	assert.match(normalized.summary, /schema mismatch/i);
	assert.equal(normalized.commit.created, false);
	assert.equal(normalized.pull_request.created, false);
});

test('formatResultMarkdown includes delivery gate, commit details, and pull request details', () => {
	const markdown = formatResultMarkdown({
		project: 'demo',
		cardId: 'FEAT-0001',
		sessionName: 'vbd-demo-FEAT-0001',
		repoPath: '/repo',
		worktreePath: '/repo/.worktrees/demo/FEAT-0001',
		result: sampleResult({
			commit: { created: false, message: '', sha: '', branch: '' },
		}),
		finalStatus: 'blocked',
		gateIssues: ['Worker did not create a commit'],
	});

	assert.match(markdown, /Reconciled status: `blocked`/);
	assert.match(markdown, /Delivery gate:/);
	assert.match(markdown, /Worker did not create a commit/);
	assert.match(markdown, /Commit created: `false`/);
	assert.match(markdown, /Pull request created: `false`/);
	assert.match(markdown, /Validation:/);
});

test('parseCreatePullRequestRequirement reads prompt metadata', () => {
	assert.equal(parseCreatePullRequestRequirement('Create pull request on success: required'), true);
	assert.equal(parseCreatePullRequestRequirement('Create pull request on success: optional'), false);
	assert.equal(parseCreatePullRequestRequirement('No metadata here'), null);
});

test('hasLiveWorker returns true when pid file points at a live process', async () => {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'prd-live-worker-'));
	const pidPath = path.join(tmp, 'worker.pid.json');
	await fs.writeFile(pidPath, `${JSON.stringify({ pid: process.pid, runner: 'process' })}\n`, 'utf8');

	assert.equal(await hasLiveWorker({ sessionName: 'missing-session', pidPaths: [pidPath] }), true);
});

test('reconcile keeps in-progress card untouched while worker pid is still alive', async () => {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'prd-reconcile-live-worker-'));
	const hubRoot = path.join(tmp, 'hub');
	const repoPath = path.join(tmp, 'repo');
	const project = 'demo';
	const cardId = 'FEAT-0001';
	const relPath = `projects/${project}/in-progress/${cardId}.md`;
	const cardPath = path.join(hubRoot, relPath);
	const worktreePath = path.join(repoPath, '.worktrees', project, cardId);
	const artifactRoot = path.join(worktreePath, '.prd-autopilot');
	const runKey = `${project}-${cardId}`;

	await fs.mkdir(path.join(hubRoot, 'projects', project, 'in-progress'), { recursive: true });
	await fs.mkdir(path.join(worktreePath, '.prd-autopilot', 'prompts'), { recursive: true });
	await fs.mkdir(path.join(worktreePath, '.prd-autopilot', 'results'), { recursive: true });
	await fs.writeFile(
		cardPath,
		`---\nid: ${cardId}\ntitle: "Test card"\ntype: feature\nstatus: in-progress\npriority: P1\ncreated_at: 2026-03-11\nupdated_at: 2026-03-11\n---\n\nBody\n`,
		'utf8',
	);
	await fs.writeFile(path.join(artifactRoot, 'prompts', `${runKey}.md`), 'prompt', 'utf8');
	await fs.writeFile(
		path.join(artifactRoot, 'results', `${runKey}.pid.json`),
		`${JSON.stringify({ pid: process.pid, runner: 'process' })}\n`,
		'utf8',
	);

	const before = await fs.readFile(cardPath, 'utf8');
	const result = await reconcileOnce({
		hubRoot,
		mapping: new Map([[project, repoPath]]),
		dryRun: false,
		tmuxPrefix: 'vbd',
		projectFilter: '',
		createPullRequest: false,
		worktreeDir: '',
		infraGraceHours: 0,
	});
	const after = await fs.readFile(cardPath, 'utf8');

	assert.equal(result.changed, false);
	assert.equal(after, before);
});
