import { expect, it } from "vitest";
import { withProjectLock } from "../src/project-lock.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

it("runs one operation per project at a time, in arrival order", async () => {
  const log: string[] = [];
  const op = (name: string) => withProjectLock("p", async () => {
    log.push(`${name}:start`);
    await tick();
    log.push(`${name}:end`);
    return name;
  });
  expect(await Promise.all([op("approve"), op("sync"), op("save")])).toEqual(["approve", "sync", "save"]);
  expect(log).toEqual(["approve:start", "approve:end", "sync:start", "sync:end", "save:start", "save:end"]);
});

it("does not serialize different projects", async () => {
  const log: string[] = [];
  const op = (id: string) => withProjectLock(id, async () => {
    log.push(`${id}:start`);
    await tick();
    log.push(`${id}:end`);
  });
  await Promise.all([op("a"), op("b")]);
  expect(log.slice(0, 2).sort()).toEqual(["a:start", "b:start"]);
});

it("releases the lock when an operation throws", async () => {
  await expect(withProjectLock("p", async () => { throw new Error("push failed"); })).rejects.toThrow("push failed");
  expect(await withProjectLock("p", async () => "next")).toBe("next");
});
