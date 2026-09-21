// Branded identifier types. Underneath, every id is a plain UUID string —
// the brand is a compile-time-only tag (it never exists at runtime) that
// stops a ProjectId from being passed where a TaskId is expected, without
// requiring a wrapper class or any runtime cost.
//
// This module has no barrel re-export by design (see packages/shared's
// package.json `exports` map): import it as `@office/shared/ids`.

import { randomUUID } from "node:crypto";

declare const brand: unique symbol;

export type Branded<Value, Tag extends string> = Value & {
  readonly [brand]: Tag;
};

export type ProjectId = Branded<string, "ProjectId">;
export type SessionId = Branded<string, "SessionId">;
export type TaskId = Branded<string, "TaskId">;
export type EventId = Branded<string, "EventId">;

function generate<Tag extends string>(): Branded<string, Tag> {
  return randomUUID() as Branded<string, Tag>;
}

export const newProjectId = (): ProjectId => generate<"ProjectId">();
export const newSessionId = (): SessionId => generate<"SessionId">();
export const newTaskId = (): TaskId => generate<"TaskId">();
export const newEventId = (): EventId => generate<"EventId">();

// Escape hatches for re-attaching a brand to a value already known to be one
// — e.g. a UUID read back out of a database row — without generating a new
// id. Prefer the `newXId` functions whenever an id is actually being minted.
export const asProjectId = (value: string): ProjectId => value as ProjectId;
export const asSessionId = (value: string): SessionId => value as SessionId;
export const asTaskId = (value: string): TaskId => value as TaskId;
export const asEventId = (value: string): EventId => value as EventId;
