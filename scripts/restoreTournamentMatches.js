const AWS = require("aws-sdk");

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "eu-north-1";
AWS.config.update({ region: REGION });
const ddb = new AWS.DynamoDB.DocumentClient();

function getArg(name, fallback = "") {
  const prefix = `--${name}=`;
  const raw = process.argv.find((arg) => arg.startsWith(prefix));
  return raw ? raw.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function usage() {
  console.log(`
Usage:
  node scripts/restoreTournamentMatches.js \\
    --source-table=ScheduleItTournamentMatchesV2-restore-20260410-2130 \\
    --target-table=ScheduleItTournamentMatchesV2 \\
    --tournament-id=f9c3b690-912c-403c-b954-fbad223f9127 \\
    [--dry-run]

What it does:
  - Reads all match rows for one tournament from the source table
  - Reads current rows for the same tournament from the target table
  - In --dry-run mode: shows counts and match keys only
  - Without --dry-run: deletes current target rows and writes source rows
`);
}

async function queryAll(tableName, tournamentId) {
  let items = [];
  let ExclusiveStartKey;

  do {
    const result = await ddb.query({
      TableName: tableName,
      KeyConditionExpression: "tournamentId = :t",
      ExpressionAttributeValues: { ":t": tournamentId },
      ExclusiveStartKey,
    }).promise();

    items = items.concat(result.Items || []);
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return items.sort((a, b) => String(a.matchKey || "").localeCompare(String(b.matchKey || "")));
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function batchWriteAll(requestItems) {
  let pending = requestItems;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await ddb.batchWrite({ RequestItems: pending }).promise();
    const unprocessed = result.UnprocessedItems || {};
    const hasUnprocessed = Object.values(unprocessed).some((rows) => Array.isArray(rows) && rows.length);
    if (!hasUnprocessed) return;
    pending = unprocessed;
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, 100 * (attempt + 1))));
  }

  throw new Error("batchWrite still has unprocessed items after retries");
}

async function deleteRows(tableName, rows) {
  for (const batch of chunk(rows, 25)) {
    await batchWriteAll({
      [tableName]: batch.map((row) => ({
        DeleteRequest: {
          Key: {
            tournamentId: row.tournamentId,
            matchKey: row.matchKey,
          },
        },
      })),
    });
  }
}

async function putRows(tableName, rows) {
  for (const batch of chunk(rows, 25)) {
    await batchWriteAll({
      [tableName]: batch.map((row) => ({
        PutRequest: {
          Item: row,
        },
      })),
    });
  }
}

async function main() {
  const sourceTable = getArg("source-table");
  const targetTable = getArg("target-table", "ScheduleItTournamentMatchesV2");
  const tournamentId = getArg("tournament-id");
  const dryRun = hasFlag("dry-run");

  if (!sourceTable || !targetTable || !tournamentId || hasFlag("help")) {
    usage();
    process.exit(sourceTable && targetTable && tournamentId ? 0 : 1);
  }

  const [sourceRows, targetRows] = await Promise.all([
    queryAll(sourceTable, tournamentId),
    queryAll(targetTable, tournamentId),
  ]);

  console.log(JSON.stringify({
    region: REGION,
    tournamentId,
    sourceTable,
    targetTable,
    sourceCount: sourceRows.length,
    targetCount: targetRows.length,
    sourceMatchKeys: sourceRows.map((row) => row.matchKey),
    targetMatchKeys: targetRows.map((row) => row.matchKey),
    dryRun,
  }, null, 2));

  if (dryRun) return;

  if (!sourceRows.length) {
    throw new Error(`No source rows found in ${sourceTable} for tournament ${tournamentId}`);
  }

  await deleteRows(targetTable, targetRows);
  await putRows(targetTable, sourceRows);

  const finalRows = await queryAll(targetTable, tournamentId);
  console.log(JSON.stringify({
    ok: true,
    restoredCount: finalRows.length,
    restoredMatchKeys: finalRows.map((row) => row.matchKey),
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
