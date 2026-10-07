// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: no composer draft store — comments
// and the open editor come from the Git panel's existing draft/send flow (agent-attach), which
// renders them; a selection resolves to the Nexus comment target via diffSelectionTarget.
import type {
  AnnotationSide,
  CodeViewDiffItem,
  CodeViewItem,
  CodeViewLineSelection,
  DiffLineAnnotation,
  FileDiffMetadata,
  SelectedLineRange,
} from '@pierre/diffs';
import { useCallback, useMemo, useState, type ReactNode } from 'react';

import {
  diffSelectionTarget,
  fnv1a32,
  type DiffSelectionTarget,
} from '../../lib/diff-rendering';
import { StyledDiffCodeView, type StyledDiffCodeViewOptions } from './StyledDiffCodeView';

/** Um comentário ancorado numa linha de um arquivo do viewer. */
export interface DiffCommentAnchor {
  readonly id: string;
  readonly fileKey: string;
  readonly side: AnnotationSide;
  readonly lineNumber: number;
}

export interface DiffCommentTarget extends DiffSelectionTarget {
  readonly fileKey: string;
}

interface DiffCommentAnnotationEntry {
  id: string;
  kind: 'draft' | 'comment';
}

interface DiffCommentAnnotationGroup {
  entries: DiffCommentAnnotationEntry[];
}

type DiffCommentLineAnnotation = DiffLineAnnotation<DiffCommentAnnotationGroup>;

function appendAnnotationEntry(
  annotations: ReadonlyArray<DiffCommentLineAnnotation>,
  anchor: Pick<DiffCommentAnchor, 'side' | 'lineNumber'>,
  entry: DiffCommentAnnotationEntry,
): DiffCommentLineAnnotation[] {
  const annotationIndex = annotations.findIndex(
    (annotation) => annotation.side === anchor.side && annotation.lineNumber === anchor.lineNumber,
  );
  if (annotationIndex < 0) {
    return [
      ...annotations,
      {
        side: anchor.side,
        lineNumber: anchor.lineNumber,
        metadata: { entries: [entry] },
      },
    ];
  }
  return annotations.map((annotation, index) =>
    index === annotationIndex
      ? {
          ...annotation,
          metadata: { entries: [...annotation.metadata.entries, entry] },
        }
      : annotation,
  );
}

interface AnnotatableCodeViewProps {
  files: ReadonlyArray<{
    fileDiff: FileDiffMetadata;
    fileKey: string;
    fileVersion: number;
  }>;
  /** Comentários já guardados (rascunhos do painel). */
  comments: ReadonlyArray<DiffCommentAnchor>;
  /** O editor aberto, se houver; desliga a seleção enquanto existe. */
  draft: DiffCommentAnchor | null;
  options: StyledDiffCodeViewOptions<DiffCommentAnnotationGroup>;
  className?: string;
  onBeginComment: (target: DiffCommentTarget) => void;
  renderDraft: () => ReactNode;
  renderComment: (id: string) => ReactNode;
}

interface DiffSelectionContext {
  item: CodeViewItem<DiffCommentAnnotationGroup>;
}

export function AnnotatableCodeView({
  files,
  comments,
  draft,
  options,
  className,
  onBeginComment,
  renderDraft,
  renderComment,
}: AnnotatableCodeViewProps) {
  const [selectedLines, setSelectedLines] = useState<CodeViewLineSelection | null>(null);

  const items = useMemo<CodeViewDiffItem<DiffCommentAnnotationGroup>[]>(
    () =>
      files.map(({ fileDiff, fileKey, fileVersion }) => {
        const persisted = comments
          .filter((comment) => comment.fileKey === fileKey)
          .reduce<DiffCommentLineAnnotation[]>(
            (annotations, comment) =>
              appendAnnotationEntry(annotations, comment, { id: comment.id, kind: 'comment' }),
            [],
          );
        const annotations =
          draft?.fileKey === fileKey
            ? appendAnnotationEntry(persisted, draft, { id: draft.id, kind: 'draft' })
            : persisted;
        return {
          id: fileKey,
          type: 'diff',
          fileDiff,
          annotations,
          version: fnv1a32(
            `${fileVersion}:${annotations
              .flatMap((annotation) =>
                annotation.metadata.entries.map(
                  (entry) => `${entry.kind}:${entry.id}@${annotation.side}:${annotation.lineNumber}`,
                ),
              )
              .join(':')}`,
          ),
        };
      }),
    [comments, draft, files],
  );

  const beginComment = useCallback(
    (range: SelectedLineRange | null, context: DiffSelectionContext) => {
      if (!range) return;
      const item = context.item;
      if (item.type !== 'diff') return;
      // Read from the item, not the file list, so this callback keeps its identity as
      // patches arrive; the viewer re-applies its options whenever it changes.
      const target = diffSelectionTarget(item.fileDiff, range);
      if (!target) return;
      setSelectedLines(null);
      onBeginComment({ ...target, fileKey: item.id });
    },
    [onBeginComment],
  );

  const hasOpenComment = draft !== null;
  return (
    <StyledDiffCodeView<DiffCommentAnnotationGroup>
      {...(className ? { className } : {})}
      items={items}
      selectedLines={selectedLines}
      onSelectedLinesChange={setSelectedLines}
      options={{
        ...options,
        enableGutterUtility: !hasOpenComment,
        enableLineSelection: !hasOpenComment,
        onGutterUtilityClick: beginComment,
      }}
      renderAnnotation={(annotation) => (
        <div className="git-scm__diff-annotation">
          {(annotation.metadata?.entries ?? []).map((entry) => (
            <div key={entry.id}>
              {entry.kind === 'draft' ? renderDraft() : renderComment(entry.id)}
            </div>
          ))}
        </div>
      )}
    />
  );
}
