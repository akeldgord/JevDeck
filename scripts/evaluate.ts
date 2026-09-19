import { Database } from 'bun:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  buildReport,
  buildReviewTemplate,
  listCompletedJobs,
  parseReviewFile,
  readRun,
  renderReportText,
  unknownVerdictCardIds,
  // Imported by path rather than by package name: this script sits at the repository root, and a
  // root-level workspace link is not something a clean checkout is guaranteed to have.
} from '../packages/evaluation/src';

/**
 * Measures the §5 quality gates against a completed generation run.
 *
 *   bun scripts/evaluate.ts [--database <path>] [--job <id>] [--verdicts <file>]
 *                           [--template <file>] [--out <file>] [--list] [--json]
 *
 * The run is read from the database, not re-run, so the numbers describe the cards that were
 * actually stored. With no `--job`, the most recent completed job is used and named in the output.
 *
 * Exit status: `1` when a gate is measured and fails, when the run or the review file cannot be
 * read, or when a review file does not belong to this run. `0` when the gates pass or when a gate
 * could not be measured — an unmet gate is not a failure of the run, and the report says so.
 */

const USAGE = [
  'Usage: bun scripts/evaluate.ts [options]',
  '',
  '  --database <path>   SQLite file to read (default $JEVDECK_DB_PATH or ./data/jevdeck.sqlite)',
  '  --job <id>          generation job to measure (default: the most recent completed job)',
  '  --verdicts <file>   independent review verdicts; without it the review gates are unmet',
  '  --template <file>   write a review file to fill in for this job',
  '  --out <file>        where to write the JSON report (default evaluations/reports/)',
  '  --list              list completed jobs and exit',
  '  --json              print the JSON report instead of the summary',
].join('\n');

function parseArgs(argv: string[]): Map<string, string | true> {
  const args = new Map<string, string | true>();

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (!argument.startsWith('--')) continue;

    const key = argument.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      args.set(key, true);
    } else {
      args.set(key, next);
      index += 1;
    }
  }

  return args;
}

/** Returns the exit status rather than exiting, so the database is closed on every path. */
async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.has('help')) {
    console.log(USAGE);
    return 0;
  }

  const databasePath =
    (args.get('database') as string) ?? process.env.JEVDECK_DB_PATH ?? './data/jevdeck.sqlite';

  let db: Database;
  try {
    db = new Database(databasePath, { readonly: true });
  } catch (cause) {
    console.error(`[jevdeck] could not open ${databasePath}: ${message(cause)}`);
    return 1;
  }

  try {
    const completed = listCompletedJobs(db);

    if (args.has('list')) {
      if (completed.length === 0) {
        console.log(`[jevdeck] ${databasePath} has no completed generation run.`);
      } else {
        for (const job of completed) {
          console.log(
            `${job.id}  ${job.coverage}  ${job.cardCount} card(s)  finished ${job.finishedAt ?? 'unknown'}`
          );
        }
      }
      return 0;
    }

    const jobId = (args.get('job') as string) ?? completed[0]?.id;

    if (!jobId) {
      console.error(
        `[jevdeck] no completed generation run in ${databasePath}. Generate a deck first, or pass --job.`
      );
      return 1;
    }

    const run = readRun(db, jobId);

    const templatePath = args.get('template') as string | undefined;
    if (templatePath) {
      mkdirSync(dirname(templatePath), { recursive: true });
      writeFileSync(
        templatePath,
        buildReviewTemplate({
          jobId,
          citations: run.citations,
          pageTextByIndex: run.pageTextByIndex,
        }),
        'utf8'
      );
      console.log(`[jevdeck] review file written to ${templatePath} — fill in every verdict.`);
    }

    let review: Awaited<ReturnType<typeof parseReviewFile>>['review'] = null;
    const verdictsPath = args.get('verdicts') as string | undefined;

    if (verdictsPath) {
      const parsed = parseReviewFile(await Bun.file(verdictsPath).text());

      if (parsed.review === null) {
        console.error(`[jevdeck] ${verdictsPath} is not a usable review file:`);
        for (const problem of parsed.problems) {
          console.error(
            `  - verdict ${problem.index}${problem.cardId ? ` (${problem.cardId})` : ''}: ${problem.problem}`
          );
        }
        console.error('The gates are left unmet rather than measured from a partial file.');
        return 1;
      }

      // A file taken against a different run is refused rather than measured: the verdicts for
      // missing cards would leave `unreviewed` too low and mix another run's cards into the rate.
      const unknown = unknownVerdictCardIds(
        run.cards.map(card => card.cardId),
        parsed.review.verdicts
      );

      if (unknown.length > 0) {
        console.error(
          `[jevdeck] ${verdictsPath} reviews ${unknown.length} card(s) that are not in job ${jobId}:`
        );
        for (const cardId of unknown.slice(0, 10)) console.error(`  - ${cardId}`);
        if (unknown.length > 10) console.error(`  - … and ${unknown.length - 10} more`);
        console.error(
          'Regenerate the review file for this job, or measure the job the file belongs to.'
        );
        return 1;
      }

      review = parsed.review;
    }

    const report = buildReport({ run, verdicts: review?.verdicts ?? [], review });

    const outPath =
      (args.get('out') as string) ??
      `evaluations/reports/${jobId}-${report.generatedAt.replace(/[:.]/g, '-')}.json`;

    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    if (args.has('json')) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(renderReportText(report));
      console.log(`\nReport written to ${outPath}`);
    }

    // A measured failure is a real failure. An unmet gate is not, so it does not fail the command
    // — but it is printed as UNMET, and the JSON records why.
    return report.summary.fail > 0 ? 1 : 0;
  } catch (cause) {
    console.error(`[jevdeck] evaluation failed: ${message(cause)}`);
    return 1;
  } finally {
    db.close();
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

process.exit(await main(process.argv.slice(2)));
