import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FEATURE_FLAG_IDS } from "../../shared/feature-flags";
import { getFeatureFlagRegistry } from "../feature-flags/feature-flag-registry";
import { ProjectRuntimeManager } from "../runtime/project-runtime-manager";
import { testProjectScope } from "./__tests__/scope-fixture";
import { createScopedMissionStore } from "./mission-store";
import { MissionEventJournal } from "./mission-event-journal";
import { ProjectDomainStoreRegistry } from "./project-domain-store-registry";
import {
  configureMissionEventEmit,
  emitMissionEvent,
} from "./mission-event-emit";
import {
  installMissionDiskProjection,
  projectMissionToDisk,
  uninstallMissionDiskProjection,
} from "./mission-disk-projection";

let baseDir = "";
const managers: ProjectRuntimeManager[] = [];
const registries: ProjectDomainStoreRegistry[] = [];

function manager(): ProjectRuntimeManager {
  const value = new ProjectRuntimeManager({
    baseDir,
    appVersion: "0.28.0-test",
  });
  managers.push(value);
  return value;
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-mission-disk-"));
});

afterEach(() => {
  uninstallMissionDiskProjection();
  configureMissionEventEmit(null);
  getFeatureFlagRegistry().clearOverride(FEATURE_FLAG_IDS.missionEventJournal);
  for (const registry of registries.splice(0)) registry.dispose();
  for (const value of managers.splice(0)) value.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe("mission disk projection", () => {
  it("projects BOARD.md, status.json and events.jsonl from the sqlite runtime", () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: "disk-projection" });
    let now = 1_000;
    const store = createScopedMissionStore(runtimeManager, scope, {
      now: () => ++now,
      idFactory: () => "mission-disk-1",
    });
    const mission = store.create({ title: "Fatia P0 legível em disco" });
    store.setStatus(mission.id, "running");

    const journal = new MissionEventJournal(runtimeManager, scope);
    journal.append({
      missionId: mission.id,
      runId: "run-kickoff",
      type: "mission.run_started",
      payload: { kind: "kickoff" },
      idempotencyKey: "kickoff-0001",
      origin: "main",
      occurredAt: 2_000,
    });

    runtimeManager
      .open(scope)
      .db.prepare(
        `INSERT INTO handoffs
           (id, mission_id, session_id, from_agent, status, summary,
            artifacts_json, delivered, created_at)
         VALUES (?, ?, ?, ?, ?, ?, '[]', 1, ?)`,
      )
      .run(
        "handoff-1",
        mission.id,
        "session-1",
        "worker-a",
        "done",
        "Entreguei a primeira fatia do board",
        3_000,
      );

    const result = projectMissionToDisk(runtimeManager, scope, mission.id);

    expect(result).not.toBeNull();
    const runtimeDirectory = runtimeManager.locationFor(scope).directory;
    const expectedDirectory = path.join(
      runtimeDirectory,
      "missions",
      mission.id,
    );
    expect(result?.directory).toBe(expectedDirectory);

    const board = fs.readFileSync(
      path.join(expectedDirectory, "BOARD.md"),
      "utf8",
    );
    expect(board).toContain("Fatia P0 legível em disco");
    expect(board).toContain("running");
    expect(board).toContain("Entreguei a primeira fatia do board");
    expect(board).toContain("mission.run_started");

    const status = JSON.parse(
      fs.readFileSync(path.join(expectedDirectory, "status.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(status.missionId).toBe(mission.id);
    expect(status.status).toBe("running");
    expect(status.handoffCount).toBe(1);
    expect(status.lastEventSequence).toBe(1);

    const eventLines = fs
      .readFileSync(path.join(expectedDirectory, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(eventLines).toHaveLength(1);
    expect(eventLines[0].type).toBe("mission.run_started");
    expect(eventLines[0].sequence).toBe(1);
  });

  it("summarizes safe payload keys and never exports raw payload content", () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: "disk-sanitize" });
    const store = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => "mission-sanitize",
    });
    const mission = store.create({ title: "Sanitize" });

    const secret = "sk-proj-SECRET-DO-NOT-EXPORT";
    const ptyChunk = "raw pty output [31mred[0m $ cat ~/.ssh/id_rsa";
    new MissionEventJournal(runtimeManager, scope).append({
      missionId: mission.id,
      runId: "run-tool",
      type: "observer.tool_result",
      payload: {
        kind: "bootstrap_progress",
        step: "workers_spawned",
        apiKey: secret,
        observer: { output: ptyChunk },
      },
      idempotencyKey: "tool-result-0001",
      origin: "main",
      occurredAt: 5_000,
    });

    const result = projectMissionToDisk(runtimeManager, scope, mission.id);
    expect(result).not.toBeNull();

    const board = fs.readFileSync(result!.boardPath, "utf8");
    const events = fs.readFileSync(result!.eventsPath, "utf8");

    for (const content of [board, events]) {
      expect(content).not.toContain(secret);
      expect(content).not.toContain("id_rsa");
      expect(content).not.toContain("raw pty output");
    }
    const line = JSON.parse(events.trim()) as Record<string, unknown>;
    expect(line.summary).toBe("kind=bootstrap_progress step=workers_spawned");
    expect(board).toContain("kind=bootstrap_progress step=workers_spawned");
  });

  it("F-780: events.jsonl carries the tool name and kind, never the tool input or output", () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: "disk-tool-identity" });
    const store = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => "mission-tool-identity",
    });
    const mission = store.create({ title: "Tool identity" });
    const journal = new MissionEventJournal(runtimeManager, scope);
    const append = (
      sequence: number,
      type: "observer.tool_call" | "observer.tool_result",
      payload: Record<string, unknown>,
    ) =>
      journal.append({
        missionId: mission.id,
        runId: "observer:abc123",
        type,
        payload: { frameSeq: sequence, sessionId: "pty-1", ...payload },
        idempotencyKey: `tool-identity-${sequence}`,
        origin: "main",
        occurredAt: 7_000 + sequence,
      });

    // Formato do projetor depois do F-780: nome/categoria no topo.
    append(1, "observer.tool_call", {
      toolName: "WebFetch",
      toolKind: "fetch",
      observer: {
        callId: "call-1",
        toolName: "WebFetch",
        input: {
          url: "https://intranet.example/relatorio?token=abc",
          prompt: "resuma o contrato confidencial",
        },
      },
    });
    // Linha gravada ANTES do F-780: nome só dentro do quadro (o caso da
    // missão Terminais) — também precisa aparecer no espelho.
    append(2, "observer.tool_call", {
      observer: { callId: "call-2", toolName: "mcp__nexus__nexus_browser_read" },
    });
    append(3, "observer.tool_result", {
      observer: {
        callId: "call-1",
        toolName: "WebFetch",
        ok: false,
        content: "<html>conteudo-secreto</html>",
      },
    });
    // ACP: o título é texto livre (caminho!) e o `kind` do protocolo informa.
    append(4, "observer.tool_call", {
      observer: {
        callId: "acp-1",
        toolName: "Read /Users/operator/.ssh/id_rsa",
        toolKind: "read",
      },
    });
    // F-780 (complemento): skill e shell-http chegam como rótulos do hook.
    append(5, "observer.tool_call", {
      toolName: "Skill",
      toolKind: "skill",
      skillName: "ponytail",
      observer: { callId: "call-5", toolName: "Skill", skillName: "ponytail" },
    });
    append(6, "observer.tool_call", {
      toolName: "Bash",
      toolKind: "shell-http",
      observer: { callId: "call-6", toolName: "Bash", toolKind: "shell-http" },
    });
    // Linha adulterada no banco: o espelho revalida e não grava texto livre.
    append(7, "observer.tool_call", {
      toolName: "Skill",
      skillName: "Deploy Prod; cat /etc/passwd",
      observer: { callId: "call-7", toolName: "Skill" },
    });

    const result = projectMissionToDisk(runtimeManager, scope, mission.id);
    expect(result).not.toBeNull();
    const events = fs.readFileSync(result!.eventsPath, "utf8");
    const lines = events
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(events).toContain('"toolName":"WebFetch"');
    expect(lines.map((line) => [line.toolName, line.toolKind, line.skillName])).toEqual([
      ["WebFetch", "fetch", undefined],
      ["mcp__nexus__nexus_browser_read", "nexus-browser", undefined],
      ["WebFetch", "fetch", undefined],
      ["<redacted-id>", "read", undefined],
      ["Skill", "skill", "ponytail"],
      ["Bash", "shell-http", undefined],
      ["Skill", "skill", undefined],
    ]);

    const board = fs.readFileSync(result!.boardPath, "utf8");
    expect(board).toContain("tool=mcp__nexus__nexus_browser_read toolKind=nexus-browser");
    expect(board).toContain("tool=Skill toolKind=skill skill=ponytail");
    expect(board).toContain("tool=Bash toolKind=shell-http");
    for (const content of [board, events]) {
      for (const leaked of [
        "intranet.example",
        "token=abc",
        "contrato confidencial",
        "conteudo-secreto",
        "/Users/operator",
        "id_rsa",
        "Deploy Prod",
        "/etc/passwd",
      ]) {
        expect(content).not.toContain(leaked);
      }
    }
  });

  it("redacts secrets and absolute paths from handoff summaries on the board", () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: "disk-handoff-redact" });
    const store = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => "mission-handoff-redact",
    });
    const mission = store.create({ title: "Handoff redact" });
    const leakedKey = "sk-proj-LEAKED-HAND OFF-TOKEN-VALUE";
    const leakedPath = "/Users/operator/.ssh/id_rsa";

    runtimeManager
      .open(scope)
      .db.prepare(
        `INSERT INTO handoffs
           (id, mission_id, session_id, from_agent, status, summary,
            artifacts_json, delivered, created_at)
         VALUES (?, ?, ?, ?, ?, ?, '[]', 1, ?)`,
      )
      .run(
        "handoff-secret",
        mission.id,
        "session-secret",
        "worker-leak",
        "done",
        `shipped with key ${leakedKey} and file ${leakedPath}`,
        4_000,
      );

    const result = projectMissionToDisk(runtimeManager, scope, mission.id);
    expect(result).not.toBeNull();
    const board = fs.readFileSync(result!.boardPath, "utf8");
    expect(board).not.toContain(leakedKey);
    expect(board).not.toContain(leakedPath);
    expect(board).not.toContain("/Users/operator");
    expect(board).toMatch(/<token>/);
    expect(board).toMatch(/<caminho>/);
  });

  it("redacts secret-shaped text from every exported human field", () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: "disk-all-fields-redact" });
    const awsKey = "AKIA1234567890ABCDEF";
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlMTIzNDU2Nzg5MA";
    const privateKey = [
      "-----BEGIN PRIVATE KEY-----",
      "opaque-private-material",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const privateRunPath = "/Users/operator/.ssh/id_rsa";
    const store = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => "mission-all-fields-redact",
    });
    const mission = store.create({
      title: `Release ${awsKey}`,
      squadId: jwt,
    });

    runtimeManager
      .open(scope)
      .db.prepare(
        `INSERT INTO handoffs
           (id, mission_id, session_id, from_agent, status, summary,
            artifacts_json, delivered, created_at)
         VALUES (?, ?, ?, ?, ?, ?, '[]', 1, ?)`,
      )
      .run(
        "handoff-all-fields-secret",
        mission.id,
        "session-all-fields-secret",
        `worker-${jwt}`,
        "done",
        privateKey,
        4_000,
      );
    new MissionEventJournal(runtimeManager, scope).append({
      missionId: mission.id,
      runId: privateRunPath,
      type: "custom",
      payload: { reason: `Bearer ${jwt}` },
      idempotencyKey: "all-fields-secret-0001",
      origin: "main",
      occurredAt: 5_000,
    });

    const result = projectMissionToDisk(runtimeManager, scope, mission.id);
    expect(result).not.toBeNull();
    const exported = [
      fs.readFileSync(result!.boardPath, "utf8"),
      fs.readFileSync(result!.statusPath, "utf8"),
      fs.readFileSync(result!.eventsPath, "utf8"),
    ].join("\n");

    for (const secret of [
      awsKey,
      jwt,
      "opaque-private-material",
      privateRunPath,
      "/Users/operator",
    ]) {
      expect(exported).not.toContain(secret);
    }
  });

  it("renders agent-authored text as bounded single lines in BOARD.md", () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: "disk-injection" });
    const store = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => "mission-injection",
    });
    const mission = store.create({ title: "Injection guard" });

    const hostile =
      "linha um\n# Status: **done** (forjado)\r\ncol | extra [31mansi[0m " +
      "x".repeat(600);
    runtimeManager
      .open(scope)
      .db.prepare(
        `INSERT INTO handoffs
           (id, mission_id, session_id, from_agent, status, summary,
            artifacts_json, delivered, created_at)
         VALUES (?, ?, 's', ?, 'done', ?, '[]', 1, 1000)`,
      )
      .run("handoff-hostile", mission.id, "a|b\nc", hostile);

    new MissionEventJournal(runtimeManager, scope).append({
      missionId: mission.id,
      runId: "run-hostile",
      type: "driver.tick",
      payload: { reason: "primeira\n## Forged section\nsegunda" },
      idempotencyKey: "hostile-0001",
      origin: "driver",
      occurredAt: 6_000,
    });

    const result = projectMissionToDisk(runtimeManager, scope, mission.id);
    const board = fs.readFileSync(result!.boardPath, "utf8");

    // Hostile event payload values must not mint board lines either.
    expect(board).not.toMatch(/^## Forged section/m);
    expect(board).toContain("primeira ## Forged section segunda");

    // A hostile summary must never mint new markdown lines or headings.
    expect(board).not.toMatch(/^# Status/m);
    expect(board).not.toContain(String.fromCharCode(27));
    const handoffLine = board
      .split("\n")
      .find((line) => line.includes("linha um"));
    expect(handoffLine).toBeDefined();
    expect(handoffLine).toContain("linha um # Status: **done** (forjado)");
    expect(handoffLine!.length).toBeLessThanOrEqual(400);
    expect(handoffLine).toContain("…");
  });

  it("refuses mission ids that could escape the projection root", () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: "disk-escape" });
    const runtimeDirectory = runtimeManager.locationFor(scope).directory;

    for (const missionId of ["../evil", "..", "a/b", ".hidden", "a\\b", ""]) {
      expect(() =>
        projectMissionToDisk(runtimeManager, scope, missionId),
      ).toThrow(/not safe/);
    }
    expect(fs.existsSync(path.join(runtimeDirectory, "missions"))).toBe(false);
    expect(
      fs.existsSync(path.join(path.dirname(runtimeDirectory), "evil")),
    ).toBe(false);
  });

  it("refuses to write through a symlinked projection file", () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: "disk-symlink" });
    const store = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => "mission-symlink",
    });
    const mission = store.create({ title: "Symlink guard" });

    const first = projectMissionToDisk(runtimeManager, scope, mission.id);
    expect(first).not.toBeNull();

    const victim = path.join(baseDir, "victim.txt");
    fs.writeFileSync(victim, "untouched");
    fs.rmSync(first!.boardPath);
    fs.symlinkSync(victim, first!.boardPath);

    expect(() =>
      projectMissionToDisk(runtimeManager, scope, mission.id),
    ).toThrow(/symlink/);
    expect(fs.readFileSync(victim, "utf8")).toBe("untouched");
  });

  it.skipIf(process.platform === "win32")(
    "applies restricted permissions to the projection directory and files",
    () => {
      const runtimeManager = manager();
      const scope = testProjectScope({ checkoutId: "disk-perms" });
      const store = createScopedMissionStore(runtimeManager, scope, {
        idFactory: () => "mission-perms",
      });
      const mission = store.create({ title: "Permissions" });

      const result = projectMissionToDisk(runtimeManager, scope, mission.id);
      expect(result).not.toBeNull();

      expect(fs.statSync(result!.directory).mode & 0o777).toBe(0o700);
      for (const filePath of [
        result!.boardPath,
        result!.statusPath,
        result!.eventsPath,
      ]) {
        expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "repairs projection permissions that were loosened after creation",
    () => {
      const runtimeManager = manager();
      const scope = testProjectScope({ checkoutId: "disk-repair-perms" });
      const store = createScopedMissionStore(runtimeManager, scope, {
        idFactory: () => "mission-repair-perms",
      });
      const mission = store.create({ title: "Repair permissions" });
      const first = projectMissionToDisk(runtimeManager, scope, mission.id);
      expect(first).not.toBeNull();

      fs.chmodSync(first!.directory, 0o777);
      for (const filePath of [
        first!.boardPath,
        first!.statusPath,
        first!.eventsPath,
      ]) {
        fs.chmodSync(filePath, 0o666);
      }

      const repaired = projectMissionToDisk(runtimeManager, scope, mission.id);
      expect(repaired).not.toBeNull();
      expect(fs.statSync(repaired!.directory).mode & 0o777).toBe(0o700);
      for (const filePath of [
        repaired!.boardPath,
        repaired!.statusPath,
        repaired!.eventsPath,
      ]) {
        expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "fsyncs the mission directory after atomically publishing files",
    () => {
      const runtimeManager = manager();
      const scope = testProjectScope({ checkoutId: "disk-directory-fsync" });
      const store = createScopedMissionStore(runtimeManager, scope, {
        idFactory: () => "mission-directory-fsync",
      });
      const mission = store.create({ title: "Directory fsync" });
      const syncedKinds: string[] = [];
      const originalFsync = fs.fsyncSync.bind(fs);
      const fsync = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        syncedKinds.push(fs.fstatSync(fd).isDirectory() ? "directory" : "file");
        originalFsync(fd);
      });

      try {
        projectMissionToDisk(runtimeManager, scope, mission.id);
      } finally {
        fsync.mockRestore();
      }

      expect(syncedKinds).toContain("file");
      expect(syncedKinds).toContain("directory");
    },
  );

  it("removes only stale projection temp files left by a crashed writer", () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: "disk-temp-recovery" });
    const store = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => "mission-temp-recovery",
    });
    const mission = store.create({ title: "Temp recovery" });
    const first = projectMissionToDisk(runtimeManager, scope, mission.id);
    expect(first).not.toBeNull();

    const stale = path.join(
      first!.directory,
      "BOARD.md.999.11111111-1111-4111-8111-111111111111.tmp",
    );
    const fresh = path.join(
      first!.directory,
      "status.json.999.22222222-2222-4222-8222-222222222222.tmp",
    );
    const unrelated = path.join(first!.directory, "operator-notes.tmp");
    fs.writeFileSync(stale, "stale");
    fs.writeFileSync(fresh, "fresh");
    fs.writeFileSync(unrelated, "keep");
    const old = new Date(Date.now() - 10 * 60 * 1_000);
    fs.utimesSync(stale, old, old);

    projectMissionToDisk(runtimeManager, scope, mission.id);

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it("refreshes the projection through the main-owned emit seam", async () => {
    const runtimeManager = manager();
    const registry = new ProjectDomainStoreRegistry(runtimeManager);
    registries.push(registry);
    const scope = testProjectScope({ checkoutId: "disk-seam" });
    const store = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => "mission-seam",
    });
    const mission = store.create({ title: "Seam refresh" });

    configureMissionEventEmit(runtimeManager);
    getFeatureFlagRegistry().setOverride(
      FEATURE_FLAG_IDS.missionEventJournal,
      true,
    );
    installMissionDiskProjection({ debounceMs: 0, registry });

    const appended = emitMissionEvent(scope, {
      missionId: mission.id,
      runId: "run-seam",
      type: "mission.run_started",
      payload: { kind: "kickoff" },
      idempotencyKey: "seam-0001",
      origin: "main",
    });
    expect(appended).toBe(true);

    const boardPath = path.join(
      runtimeManager.locationFor(scope).directory,
      "missions",
      mission.id,
      "BOARD.md",
    );
    await vi.waitFor(() => {
      expect(fs.existsSync(boardPath)).toBe(true);
    });
    expect(fs.readFileSync(boardPath, "utf8")).toContain("mission.run_started");
  });

  it("refreshes after direct mission and handoff store mutations", async () => {
    const runtimeManager = manager();
    const registry = new ProjectDomainStoreRegistry(runtimeManager);
    registries.push(registry);
    const scope = testProjectScope({ checkoutId: "disk-store-change" });

    configureMissionEventEmit(runtimeManager);
    installMissionDiskProjection({ debounceMs: 0, registry });

    const suite = registry.forScope(scope);
    const mission = suite.missions.create({ title: "Store-driven mirror" });
    suite.missions.setStatus(mission.id, "running");

    const boardPath = path.join(
      runtimeManager.locationFor(scope).directory,
      "missions",
      mission.id,
      "BOARD.md",
    );
    const statusPath = path.join(path.dirname(boardPath), "status.json");
    await vi.waitFor(() => {
      expect(fs.existsSync(statusPath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(statusPath, "utf8")).status).toBe(
        "running",
      );
    });

    suite.handoffs.submit({
      missionId: mission.id,
      sessionId: "session-store-change",
      fromAgent: "worker-store-change",
      status: "success",
      summary: "handoff apareceu sem depender de evento auxiliar",
    });

    await vi.waitFor(() => {
      expect(fs.readFileSync(boardPath, "utf8")).toContain(
        "handoff apareceu sem depender de evento auxiliar",
      );
    });
  });

  it("rebuilds a missing projection when a persisted scope reopens", async () => {
    const scope = testProjectScope({ checkoutId: "disk-restart" });
    const firstManager = manager();
    const firstRegistry = new ProjectDomainStoreRegistry(firstManager);
    registries.push(firstRegistry);
    const mission = firstRegistry
      .forScope(scope)
      .missions.create({ title: "Recovered after restart" });
    firstRegistry.dispose();
    firstManager.closeAll();

    const restartedManager = manager();
    const restartedRegistry = new ProjectDomainStoreRegistry(restartedManager);
    registries.push(restartedRegistry);
    configureMissionEventEmit(restartedManager);
    installMissionDiskProjection({
      debounceMs: 0,
      registry: restartedRegistry,
    });

    // Opening the persisted scope must seed the derived files even before a
    // new mission mutation or journal event occurs.
    restartedRegistry.forScope(scope);

    const boardPath = path.join(
      restartedManager.locationFor(scope).directory,
      "missions",
      mission.id,
      "BOARD.md",
    );
    await vi.waitFor(() => {
      expect(fs.readFileSync(boardPath, "utf8")).toContain(
        "Recovered after restart",
      );
    });
  });

  it("uninstall cancels pending refreshes so shutdown never reopens the runtime", async () => {
    const runtimeManager = manager();
    const registry = new ProjectDomainStoreRegistry(runtimeManager);
    registries.push(registry);
    const scope = testProjectScope({ checkoutId: "disk-shutdown" });
    const store = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => "mission-shutdown",
    });
    const mission = store.create({ title: "Shutdown guard" });

    configureMissionEventEmit(runtimeManager);
    getFeatureFlagRegistry().setOverride(
      FEATURE_FLAG_IDS.missionEventJournal,
      true,
    );
    installMissionDiskProjection({ debounceMs: 30, registry });

    const appended = emitMissionEvent(scope, {
      missionId: mission.id,
      runId: "run-shutdown",
      type: "mission.run_started",
      payload: { kind: "kickoff" },
      idempotencyKey: "shutdown-0001",
      origin: "main",
    });
    expect(appended).toBe(true);

    // Teardown while the debounce window is still open.
    uninstallMissionDiskProjection();

    await new Promise((resolve) => setTimeout(resolve, 80));
    const boardPath = path.join(
      runtimeManager.locationFor(scope).directory,
      "missions",
      mission.id,
      "BOARD.md",
    );
    expect(fs.existsSync(boardPath)).toBe(false);
  });
});
