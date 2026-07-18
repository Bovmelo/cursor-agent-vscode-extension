import assert from "node:assert/strict";
import test from "node:test";
import {
  hardStopBackgroundWorkerProcess,
  inspectBackgroundProcess,
  isSameBackgroundWorkerProcess,
} from "../out/backgroundProcess.js";

const expected = {
  pid: 42,
  token: "unguessable-token",
  startedAt: 10_000,
  processStartId: "linux:98765",
  workerFile: "/extension/out/backgroundWorker.js",
  jobFile: "/storage/job.json",
  executableFile: "/usr/bin/node",
};
const heartbeat = {
  token: expected.token,
  pid: expected.pid,
  startedAt: expected.startedAt,
  processStartId: expected.processStartId,
  updatedAt: 20_000,
};
const identity = {
  pid: expected.pid,
  startId: expected.processStartId,
  commandLine: [
    "/usr/bin/node",
    expected.workerFile,
    expected.jobFile,
    expected.token,
  ].join(" "),
  argv: [
    "/usr/bin/node",
    expected.workerFile,
    expected.jobFile,
    expected.token,
  ],
};

test("live process inspection returns a stable OS start identity", async () => {
  const first = await inspectBackgroundProcess(process.pid);
  const second = await inspectBackgroundProcess(process.pid);

  assert.equal(first.state, "running");
  assert.equal(second.state, "running");
  assert.equal(second.identity.pid, process.pid);
  assert.equal(second.identity.startId, first.identity.startId);
});

test("restored worker identity requires token, PID, start identity, and command", () => {
  assert.equal(isSameBackgroundWorkerProcess(expected, heartbeat, identity), true);
  assert.equal(
    isSameBackgroundWorkerProcess(expected, { ...heartbeat, token: "other" }, identity),
    false,
  );
  assert.equal(
    isSameBackgroundWorkerProcess(expected, heartbeat, { ...identity, startId: "linux:98766" }),
    false,
  );
  assert.equal(
    isSameBackgroundWorkerProcess(expected, heartbeat, {
      ...identity,
      argv: identity.argv.filter((value) => value !== expected.token),
    }),
    false,
  );
  assert.equal(
    isSameBackgroundWorkerProcess({ ...expected, processStartId: undefined }, heartbeat, identity),
    false,
  );
  assert.equal(isSameBackgroundWorkerProcess(expected, heartbeat, {
    pid: expected.pid,
    startId: expected.processStartId,
    executablePath: expected.executableFile,
  }), true);
  assert.equal(isSameBackgroundWorkerProcess(expected, heartbeat, {
    pid: expected.pid,
    startId: expected.processStartId,
    executablePath: "/some/other/runtime",
  }), false);
});

test("restored worker hard stop fails closed on PID reuse", async () => {
  const signalled = [];
  const result = await hardStopBackgroundWorkerProcess(expected, heartbeat, {
    inspectProcess: async () => ({
      state: "running",
      identity: { ...identity, startId: "linux:reused-pid" },
    }),
    signalProcess: (pid) => signalled.push(pid),
  });

  assert.equal(result, "identity-mismatch");
  assert.deepEqual(signalled, []);
});

test("restored worker hard stop signals only an exactly matched process", async () => {
  const signalled = [];
  const result = await hardStopBackgroundWorkerProcess(expected, heartbeat, {
    inspectProcess: async () => ({ state: "running", identity }),
    signalProcess: (pid) => signalled.push(pid),
  });

  assert.equal(result, "signalled");
  assert.deepEqual(signalled, [expected.pid]);
});

test("a retained child handle fails closed before authenticated start identity exists", async () => {
  const signals = [];
  const child = {
    pid: expected.pid,
    exitCode: null,
    signalCode: null,
    kill(signal) {
      signals.push(signal);
      return true;
    },
  };

  const result = await hardStopBackgroundWorkerProcess(expected, undefined, {
    managedChild: child,
    inspectProcess: async () => ({ state: "running", identity }),
  });

  assert.equal(result, "identity-mismatch");
  assert.deepEqual(signals, []);
});

test("a retained child handle cannot bypass a reused PID identity mismatch", async () => {
  const signals = [];
  const child = {
    pid: expected.pid,
    exitCode: null,
    signalCode: null,
    kill(signal) {
      signals.push(signal);
      return true;
    },
  };

  const result = await hardStopBackgroundWorkerProcess(expected, heartbeat, {
    managedChild: child,
    inspectProcess: async () => ({
      state: "running",
      identity: { ...identity, startId: "linux:reused-pid" },
    }),
  });

  assert.equal(result, "identity-mismatch");
  assert.deepEqual(signals, []);
});

test("a retained child handle signals only after live OS identity matches", async () => {
  const signals = [];
  const child = {
    pid: expected.pid,
    exitCode: null,
    signalCode: null,
    kill(signal) {
      signals.push(signal);
      return true;
    },
  };

  const result = await hardStopBackgroundWorkerProcess(expected, heartbeat, {
    managedChild: child,
    inspectProcess: async () => ({ state: "running", identity }),
  });

  assert.equal(result, "signalled");
  assert.deepEqual(signals, ["SIGKILL"]);
});
