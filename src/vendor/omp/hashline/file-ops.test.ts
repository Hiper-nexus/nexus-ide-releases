// Vendored from can1357/oh-my-pi@03c48d073 packages/hashline (MIT)
// Test suite ported from bun:test to vitest for the NexusIDE vendored copy.
import { describe, expect, it } from "vitest";
import {
	computeFileHash,
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
	parsePatch,
} from "./index";

const PATH = "src/old.ts";
const DEST = "src/new.ts";
const CONTENT = "one\ntwo\nthree\n";

describe("hashline file ops", () => {
	it("parses REM and rejects line ops in the same section", () => {
		expect(parsePatch("REM").fileOp).toEqual({ kind: "rem" });
		expect(() => parsePatch(`SWAP 1.=1:\n+one\nREM`)).toThrow(/REM.*line ops/);
	});

	it("parses MV with a normalized destination path", () => {
		const section = Patch.parseSingle(`[${PATH}#AB12]\nMV ${DEST}`);
		expect(section.fileOp).toEqual({ kind: "move", dest: DEST });
	});

	it("deletes a tagged file with REM", async () => {
		const fs = new InMemoryFilesystem([[PATH, CONTENT]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, CONTENT);
		const patcher = new Patcher({ fs, snapshots });

		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nREM`));

		expect(result.sections[0]?.op).toBe("delete");
		expect(fs.get(PATH)).toBeUndefined();
		expect(snapshots.byHash(PATH, tag)).toBeNull();
	});

	it("moves a file without content edits", async () => {
		const fs = new InMemoryFilesystem([[PATH, CONTENT]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, CONTENT, [1, 2]);
		const patcher = new Patcher({ fs, snapshots });

		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nMV ${DEST}`));

		expect(result.sections[0]?.op).toBe("update");
		expect(result.sections[0]?.moveDest).toBe(DEST);
		expect(fs.get(PATH)).toBeUndefined();
		expect(fs.get(DEST)).toBe(CONTENT);
		expect(snapshots.byHash(DEST, tag)?.text).toBe(CONTENT);
		expect(snapshots.byHash(DEST, tag)?.seenLines).toEqual(new Set([1, 2]));
		expect(snapshots.byHash(PATH, tag)).toBeNull();
	});

	it("applies line edits then moves the updated content", async () => {
		const fs = new InMemoryFilesystem([[PATH, CONTENT]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, CONTENT);
		const patcher = new Patcher({ fs, snapshots });

		const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\nSWAP 2.=2:\n+TWO\nMV ${DEST}`));

		expect(result.sections[0]?.moveDest).toBe(DEST);
		expect(fs.get(PATH)).toBeUndefined();
		expect(fs.get(DEST)).toBe("one\nTWO\nthree\n");
		expect(result.sections[0]?.fileHash).toBe(computeFileHash("one\nTWO\nthree\n"));
		expect(snapshots.head(DEST)?.hash).toBe(result.sections[0]?.fileHash);
	});

	it("revalidates between move legs and reports the partial destination explicitly", async () => {
		const fs = new InMemoryFilesystem([[PATH, CONTENT]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, CONTENT);
		let authorityChecks = 0;
		const patcher = new Patcher({
			fs,
			snapshots,
			assertCurrentAuthority: () => {
				authorityChecks += 1;
				if (authorityChecks === 2) throw new Error("session_authority_revoked");
			},
		});

		await expect(patcher.apply(Patch.parse(`[${PATH}#${tag}]\nMV ${DEST}`))).rejects.toThrow(
			/effectMayHaveCommitted: move destination.*source.*not removed/,
		);
		expect(authorityChecks).toBe(2);
		expect(fs.get(PATH)).toBe(CONTENT);
		expect(fs.get(DEST)).toBe(CONTENT);
		expect(snapshots.byHash(PATH, tag)?.text).toBe(CONTENT);
	});
});
