import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type Change = { status: string; path: string };
type Commit = { hash: string; authoredAt: string; subject: string };

const PUBLISH_SUBJECT = 'Published your App';
const DEFAULT_OUTPUT_DIR = 'release-reports/generated';
const BLOCKED_PATHS = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(attached_assets|uploads?|private|secrets?|application-data|records?)(\/|$)/i,
  /\.(?:db|sqlite|sqlite3|pem|key|p12|pfx)$/i,
];

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function parseArgs(argv: string[]) {
  let candidate = 'HEAD';
  let outputDir = DEFAULT_OUTPUT_DIR;
  let htmlOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--candidate') candidate = argv[++index] ?? '';
    else if (arg === '--output-dir') outputDir = argv[++index] ?? '';
    else if (arg === '--html-only') htmlOnly = true;
    else if (arg === '--help') {
      console.log(`Usage: pnpm release-report [--candidate <revision>] [--output-dir <directory>] [--html-only]

Discovers the newest "Published your App" commit on the current main ancestry.
The candidate defaults to HEAD and must descend from that baseline.
Generated narrative is deliberately limited to scope facts; stakeholder feature claims require manual review.`);
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!candidate || !outputDir) throw new Error('Candidate and output directory must not be empty.');
  return { candidate, outputDir, htmlOnly };
}

function assertAncestor(ancestor: string, descendant: string, message: string): void {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant]);
  if (result.status !== 0) throw new Error(message);
}

function parseChanges(range: string): Change[] {
  const output = git(['diff', '--name-status', '-z', '--find-renames', range]);
  if (!output) return [];
  const fields = output.split('\0');
  const changes: Change[] = [];

  for (let index = 0; index < fields.length && fields[index]; ) {
    const status = fields[index++];
    if (status.startsWith('R') || status.startsWith('C')) {
      const from = fields[index++];
      const to = fields[index++];
      changes.push({ status, path: `${from} → ${to}` });
    } else {
      changes.push({ status, path: fields[index++] });
    }
  }
  return changes;
}

function renderHtml(input: {
  baseline: string;
  candidate: string;
  commits: Commit[];
  changes: Change[];
  additions: number;
  deletions: number;
  generatedAt: string;
}): string {
  const shortBaseline = input.baseline.slice(0, 7);
  const shortCandidate = input.candidate.slice(0, 7);
  const commitRows = input.commits
    .map(
      (commit, index) =>
        `<tr><td>${index + 1}</td><td><code>${commit.hash}</code></td><td>${escapeHtml(commit.authoredAt)}</td><td>${escapeHtml(commit.subject)}</td></tr>`,
    )
    .join('');
  const pathRows = input.changes
    .map(
      (change, index) =>
        `<tr><td>${index + 1}</td><td><code>${escapeHtml(change.status)}</code></td><td><code>${escapeHtml(change.path)}</code></td></tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="release-baseline" content="${input.baseline}">
<meta name="release-current" content="${input.candidate}">
<meta name="release-commit-count" content="${input.commits.length}">
<meta name="release-file-count" content="${input.changes.length}">
<title>CEPS Portal pre-publish report — ${shortBaseline} to ${shortCandidate}</title>
<style>
:root{--navy:#0b2440;--cyan:#00a8e0;--ink:#142433;--muted:#5f6f7d;--line:#d8e1e8;--soft:#f4f8fb;--amber:#956400}*{box-sizing:border-box}html{background:#eef3f6;color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.5}body{margin:0}.page{width:min(1120px,calc(100% - 32px));margin:32px auto;background:#fff;box-shadow:0 18px 60px #0b24401f}header{padding:54px 64px;color:#fff;background:linear-gradient(135deg,var(--navy),#007ea8)}header p{color:#d8f3fc;max-width:760px}main{padding:38px 64px 64px}h1{font-size:40px;margin:8px 0}h2{color:var(--navy);border-bottom:3px solid var(--cyan);padding-bottom:8px;margin-top:42px}.facts{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.fact{border:1px solid var(--line);border-top:4px solid var(--cyan);padding:16px}.fact strong{display:block;font-size:24px;color:var(--navy)}.warning{border-left:5px solid #d79a00;background:#fff8e5;padding:16px;margin:22px 0}.meta{display:grid;grid-template-columns:1fr 1fr;gap:12px;background:var(--soft);padding:18px}.meta strong{display:block;color:var(--muted);font-size:12px;text-transform:uppercase}table{width:100%;border-collapse:collapse;font-size:12px}th{text-align:left;background:var(--soft)}th,td{padding:8px;border-bottom:1px solid var(--line);vertical-align:top}code{overflow-wrap:anywhere}.appendix{break-before:page}@media(max-width:760px){header,main{padding-left:24px;padding-right:24px}.facts,.meta{grid-template-columns:1fr}}@media print{@page{size:Letter;margin:.55in}html{background:#fff}.page{width:auto;margin:0;box-shadow:none}header{margin:-.55in -.55in 0;padding:42px .55in}.facts{grid-template-columns:repeat(4,1fr)}main{padding:24px 0 0}tr{break-inside:avoid}}
</style>
</head>
<body><div class="page">
<header><div>CEPS Portal · Pre-publish briefing</div><h1>Git-audited release scope</h1><p>Generated evidence for stakeholder review. This document describes the revision range and appendices; it does not approve feature claims.</p></header>
<main>
<section class="facts">
<div class="fact"><strong>${input.commits.length}</strong><span>Included commits</span></div>
<div class="fact"><strong>${input.changes.length}</strong><span>Changed paths</span></div>
<div class="fact"><strong>+${input.additions.toLocaleString('en-US')}</strong><span>Line additions</span></div>
<div class="fact"><strong>−${input.deletions.toLocaleString('en-US')}</strong><span>Line deletions</span></div>
</section>
<section><h2>Report identity and scope</h2><div class="meta">
<div><strong>Publish baseline</strong><code>${input.baseline}</code></div>
<div><strong>Release candidate</strong><code>${input.candidate}</code></div>
<div><strong>Revision range</strong><code>${shortBaseline}..${shortCandidate}</code></div>
<div><strong>Generated</strong>${escapeHtml(input.generatedAt)}</div>
</div>
<div class="warning"><strong>Manual narrative review required.</strong> Commit subjects below are unreviewed Git metadata, not approved stakeholder-facing feature claims. Add and approve narrative separately before publishing this report.</div>
</section>
<section class="appendix"><h2>Appendix A — exact commits (${input.commits.length})</h2>
<table><thead><tr><th>#</th><th>Commit</th><th>Authored</th><th>Unreviewed Git subject</th></tr></thead><tbody>${commitRows}</tbody></table>
</section>
<section class="appendix"><h2>Appendix B — exact changed paths (${input.changes.length})</h2>
<table><thead><tr><th>#</th><th>Status</th><th>Path</th></tr></thead><tbody>${pathRows}</tbody></table>
</section>
</main></div></body></html>`;
}

function countRows(html: string, appendix: 'A' | 'B'): number {
  const match = html.match(new RegExp(`Appendix ${appendix}[\\s\\S]*?<tbody>([\\s\\S]*?)<\\/tbody>`));
  return match?.[1].match(/<tr>/g)?.length ?? 0;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const repositoryRoot = git(['rev-parse', '--show-toplevel']);
  const mainRevision = git(['rev-parse', '--verify', 'refs/heads/main^{commit}']);
  const candidate = git(['rev-parse', '--verify', `${options.candidate}^{commit}`]);
  const publishLog = git(['log', '--format=%H%x00%s', mainRevision]);
  const baseline = publishLog
    .split('\n')
    .map((line) => line.split('\0'))
    .find(([, subject]) => subject === PUBLISH_SUBJECT)?.[0];
  if (!baseline) throw new Error(`No "${PUBLISH_SUBJECT}" commit found on current main ancestry.`);

  assertAncestor(
    baseline,
    candidate,
    `Candidate ${candidate} is not descended from publish baseline ${baseline}.`,
  );

  const range = `${baseline}..${candidate}`;
  const commits: Commit[] = git([
    'log',
    '--reverse',
    '--format=%H%x00%aI%x00%s',
    range,
  ])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, authoredAt, subject] = line.split('\0');
      return { hash, authoredAt, subject };
    });
  const changes = parseChanges(range);
  const blocked = changes.filter((change) =>
    BLOCKED_PATHS.some((pattern) => pattern.test(change.path)),
  );
  if (blocked.length > 0) {
    throw new Error(
      `Refusing to include sensitive, uploaded, or application-record paths:\n${blocked.map((item) => `- ${item.path}`).join('\n')}`,
    );
  }

  const numstat = git(['diff', '--numstat', range]);
  let additions = 0;
  let deletions = 0;
  for (const line of numstat.split('\n').filter(Boolean)) {
    const [added, deleted] = line.split('\t');
    if (added !== '-') additions += Number(added);
    if (deleted !== '-') deletions += Number(deleted);
  }

  const html = renderHtml({
    baseline,
    candidate,
    commits,
    changes,
    additions,
    deletions,
    generatedAt: new Date().toISOString(),
  });
  const expectedCommitCount = Number(git(['rev-list', '--count', range]));
  const expectedPathCount = git(['diff', '--name-only', '-z', range])
    .split('\0')
    .filter(Boolean).length;
  const actualCommitCount = countRows(html, 'A');
  const actualPathCount = countRows(html, 'B');
  if (actualCommitCount !== expectedCommitCount || actualPathCount !== expectedPathCount) {
    throw new Error(
      `Appendix completeness check failed: commits ${actualCommitCount}/${expectedCommitCount}, paths ${actualPathCount}/${expectedPathCount}.`,
    );
  }

  const outputDir = resolve(repositoryRoot, options.outputDir);
  mkdirSync(outputDir, { recursive: true });
  const stem = `ceps-release-report-${baseline.slice(0, 7)}-to-${candidate.slice(0, 7)}`;
  const htmlPath = resolve(outputDir, `${stem}.html`);
  const pdfPath = resolve(outputDir, `${stem}.pdf`);
  writeFileSync(htmlPath, html);

  if (!options.htmlOnly) {
    const chromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? '/repl/tools/bin/chromium';
    rmSync(pdfPath, { force: true });
    const rendered = spawnSync(
      chromium,
      ['--headless', '--no-sandbox', '--disable-gpu', `--print-to-pdf=${pdfPath}`, pathToFileURL(htmlPath).href],
      { encoding: 'utf8' },
    );
    if (rendered.status !== 0) {
      throw new Error(`PDF rendering failed:\n${rendered.stderr || rendered.stdout}`);
    }
    readFileSync(pdfPath);
  }

  console.log(`Baseline: ${baseline}`);
  console.log(`Candidate: ${candidate}`);
  console.log(`Verified appendices: ${commits.length} commits, ${changes.length} changed paths`);
  console.log(`HTML: ${htmlPath}`);
  if (!options.htmlOnly) console.log(`PDF: ${pdfPath}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}