const { CloudTasksClient } = require('@google-cloud/tasks');

let client;
function getClient() {
  if (!client) client = new CloudTasksClient();
  return client;
}

// Enqueues one task per sendAlertEmail call (all recipients batched together).
// Cloud Tasks dispatches tasks at ≤4/sec so Resend's batch endpoint is never flooded.
async function enqueueEmailBatch({ recipients, subject, html }) {
  const project  = process.env.GCP_PROJECT_ID;
  const location = process.env.GCP_TASKS_LOCATION;
  const queue    = process.env.CLOUD_TASKS_QUEUE || 'email-queue';
  const serviceUrl          = process.env.CLOUD_RUN_URL;
  const serviceAccountEmail = process.env.GCP_SERVICE_ACCOUNT_EMAIL;

  const parent = getClient().queuePath(project, location, queue);

  await getClient().createTask({
    parent,
    task: {
      httpRequest: {
        httpMethod: 'POST',
        url: `${serviceUrl}/internal/send-email`,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ recipients, subject, html })).toString('base64'),
        oidcToken: {
          serviceAccountEmail,
          audience: serviceUrl,
        },
      },
    },
  });
}

module.exports = { enqueueEmailBatch };
