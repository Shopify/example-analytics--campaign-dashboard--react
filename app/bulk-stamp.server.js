import {clearStampOperation} from './campaign-state.server';
import {transportErrors} from './campaigns.server';

// [START campaign-dashboard.bulk-stamp-orders]
// A bulk mutation reads its variables from a JSONL file uploaded to a staged target.
export const STAGE_BULK_VARIABLES = `
  mutation StageBulkVariables($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        parameters {
          name
          value
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// Shopify runs this once for each line of the file, with the line as its variables.
export const BULK_METAFIELDS_SET = `mutation SetMetafieldsInBulk($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message code } } }`;

export const RUN_BULK_MUTATION = `
  mutation RunBulkMutation($mutation: String!, $stagedUploadPath: String!) {
    bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $stagedUploadPath) {
      bulkOperation {
        id
        status
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

// `metafieldsSet` takes up to 25 metafields per call, so each line holds up to 25.
export const METAFIELDS_PER_LINE = 25;

export function metafieldsJsonl(metafields) {
  const lines = [];
  for (let start = 0; start < metafields.length; start += METAFIELDS_PER_LINE) {
    lines.push(JSON.stringify({metafields: metafields.slice(start, start + METAFIELDS_PER_LINE)}));
  }
  return `${lines.join('\n')}\n`;
}

// Returns the operation's ID. The page polls it, and the request doesn't wait.
export async function startBulkMetafieldsSet(admin, metafields, filename) {
  if (!metafields.length) return {operationId: null, userErrors: []};

  const staged = await (
    await admin.graphql(STAGE_BULK_VARIABLES, {
      variables: {
        input: [{resource: 'BULK_MUTATION_VARIABLES', filename, mimeType: 'text/jsonl', httpMethod: 'POST'}],
      },
    })
  ).json();
  const target = staged.data?.stagedUploadsCreate?.stagedTargets?.[0];
  const unstaged = [...transportErrors(staged), ...(staged.data?.stagedUploadsCreate?.userErrors ?? [])];
  if (unstaged.length) return {operationId: null, userErrors: unstaged};
  if (!target?.url) {
    return {operationId: null, userErrors: [{message: "Shopify returned no upload target. Try again."}]};
  }

  // Every parameter goes into the form, and the file has to come last.
  const form = new FormData();
  for (const {name, value} of target.parameters) form.append(name, value);
  form.append('file', new Blob([metafieldsJsonl(metafields)], {type: 'text/jsonl'}), filename);
  const uploaded = await fetch(target.url, {method: 'POST', body: form}).catch((error) => ({
    ok: false,
    status: error.message,
  }));
  if (!uploaded.ok) {
    return {operationId: null, userErrors: [{message: `The upload failed (${uploaded.status}). Try again.`}]};
  }

  // The staged upload path is the `key` parameter.
  const stagedUploadPath = target.parameters.find((parameter) => parameter.name === 'key')?.value;
  const run = await (
    await admin.graphql(RUN_BULK_MUTATION, {
      variables: {mutation: BULK_METAFIELDS_SET, stagedUploadPath},
    })
  ).json();
  const result = run.data?.bulkOperationRunMutation;
  const userErrors = [...transportErrors(run), ...(result?.userErrors ?? [])];
  const operationId = userErrors.length ? null : (result?.bulkOperation?.id ?? null);
  if (!operationId && !userErrors.length) {
    userErrors.push({message: "Shopify didn't start the bulk operation. Try again."});
  }
  return {operationId, userErrors};
}
// [END campaign-dashboard.bulk-stamp-orders]

// [START campaign-dashboard.bulk-stamp-poll]
export const BULK_OPERATION = `
  query StampOperation($id: ID!) {
    bulkOperation(id: $id) {
      id
      status
      errorCode
      objectCount
      url
    }
  }
`;

const RUNNING = new Set(['CREATED', 'RUNNING', 'CANCELING']);

// A completed operation can still reject lines. Each output line holds that line's
// `userErrors`, or top-level `errors` for variables that didn't fit the mutation.
async function rejectedLines(url) {
  const response = await fetch(url).catch(() => null);
  if (!response?.ok) return [{message: "Couldn't read the bulk operation's results. Reload to try again."}];
  return (await response.text())
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const result = JSON.parse(line);
      return [...(result.errors ?? []), ...(result.data?.metafieldsSet?.userErrors ?? [])];
    })
    .map((error) => ({message: error.message}));
}

// `running`, `done`, `failed`, or `unread`. Only `failed` offers a retry.
export async function readBulkOperation(admin, id) {
  const body = await (await admin.graphql(BULK_OPERATION, {variables: {id}})).json();
  const unread = transportErrors(body);
  if (unread.length) return {state: 'unread', objectCount: 0, problems: unread};

  const operation = body.data?.bulkOperation;
  if (!operation) {
    return {state: 'failed', objectCount: 0, problems: [{message: 'Shopify has no record of the bulk operation.'}]};
  }
  const objectCount = Number(operation.objectCount ?? 0);
  if (RUNNING.has(operation.status)) return {state: 'running', objectCount, problems: []};
  if (operation.status !== 'COMPLETED') {
    const reason = operation.errorCode ? ` (${operation.errorCode})` : '';
    return {
      state: 'failed',
      objectCount,
      problems: [{message: `The bulk operation ended ${operation.status.toLowerCase()}${reason}.`}],
    };
  }
  // A completed operation with no input lines has no output file.
  const problems = operation.url ? await rejectedLines(operation.url) : [];
  return {state: problems.length ? 'failed' : 'done', objectCount, problems};
}

// A clean finish clears the record, and the next load shows nothing. A failure stays for a retry.
export async function readStamping(admin, campaign) {
  if (campaign.status !== 'closed' || !campaign.stampOperation) return null;
  const stamping = await readBulkOperation(admin, campaign.stampOperation);
  if (stamping.state === 'done') {
    await clearStampOperation(campaign.shop, campaign.id, campaign.stampOperation).catch((error) =>
      console.error('Could not clear the stamp operation', error),
    );
  }
  return stamping;
}
// [END campaign-dashboard.bulk-stamp-poll]
