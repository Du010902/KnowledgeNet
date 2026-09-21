/**
 * 学习目标：根目录 `.knowledgenet/goals.json`
 *
 * 目标属于**整个知识库**（不属于某个节点），所以它放在知识库根部的元数据目录里，
 * 而不是任何一个节点文件夹内。缺失时返回空文件：刚建好的知识库本来就没有目标。
 *
 * 目标指向的入口节点可能被移除身份或被删除，这时**不自动删除目标**：
 * 图谱上显示为缺失占位，用户可以在完整性检查里看到并决定怎么办。
 */
import { RepositoryError } from "../errors.ts";
import type { Goal } from "../types.ts";
import { newUuid } from "../uuid.ts";
import {
  emptyGoals,
  isoFromMs,
  parseGoalsFile,
  parseIsoMs,
  serializeJson,
  type V2GoalEntry,
  type V2GoalsFile,
} from "./schema.ts";
import { sha256Hex } from "./hash.ts";
import { writeTextAtomic, type Vfs } from "./fs.ts";
import { GOALS_FILE } from "./paths.ts";

export interface GoalsSnapshot {
  file: V2GoalsFile;
  sha256: string;
}

export async function readGoalsFile(vfs: Vfs, libraryId: string): Promise<GoalsSnapshot> {
  let text: string | null = null;
  try {
    text = await vfs.read(GOALS_FILE);
  } catch {
    text = null;
  }
  if (text === null) return { file: emptyGoals(libraryId), sha256: "" };
  const file = parseGoalsFile(text, GOALS_FILE);
  return { file, sha256: sha256Hex(text) };
}

function goalToDomain(entry: V2GoalEntry): Goal {
  return {
    id: entry.id,
    title: entry.title,
    rootNodeId: entry.rootNodeId,
    createdAt: parseIsoMs(entry.createdAt),
  };
}

export function goalToFile(goal: Goal): V2GoalEntry {
  return {
    id: goal.id,
    title: goal.title,
    rootNodeId: goal.rootNodeId,
    createdAt: isoFromMs(goal.createdAt),
  };
}

export async function listGoals(vfs: Vfs, libraryId: string): Promise<Goal[]> {
  const { file } = await readGoalsFile(vfs, libraryId);
  return file.goals.map(goalToDomain);
}

async function mutateGoals(
  vfs: Vfs,
  libraryId: string,
  mutate: (file: V2GoalsFile) => void,
): Promise<V2GoalsFile> {
  const current = await readGoalsFile(vfs, libraryId);
  const file: V2GoalsFile = { ...current.file, libraryId, goals: [...current.file.goals] };
  mutate(file);
  file.revision = current.sha256 === "" ? Math.max(1, file.revision) : current.file.revision + 1;
  await writeTextAtomic(vfs, GOALS_FILE, serializeJson(file));
  return file;
}

export async function saveGoal(
  vfs: Vfs,
  libraryId: string,
  title: string,
  rootNodeId: string,
  goalId?: string,
): Promise<Goal> {
  const now = Date.now();
  const entry: V2GoalEntry = {
    id: goalId ?? newUuid(now),
    title: title.trim() || "未命名目标",
    rootNodeId,
    createdAt: isoFromMs(now),
  };
  const file = await mutateGoals(vfs, libraryId, (draft) => {
    draft.goals.push(entry);
  });
  const saved = file.goals.find((goal) => goal.id === entry.id);
  if (!saved) throw new RepositoryError("internal", "写入学习目标失败");
  return goalToDomain(saved);
}

export async function renameGoal(
  vfs: Vfs,
  libraryId: string,
  goalId: string,
  title: string,
): Promise<Goal> {
  const file = await mutateGoals(vfs, libraryId, (draft) => {
    const goal = draft.goals.find((item) => item.id === goalId);
    if (goal) goal.title = title.trim() || goal.title;
  });
  const saved = file.goals.find((goal) => goal.id === goalId);
  if (!saved) throw new RepositoryError("not_found", `学习目标不存在：${goalId}`);
  return goalToDomain(saved);
}

export async function deleteGoal(vfs: Vfs, libraryId: string, goalId: string): Promise<boolean> {
  let removed = false;
  await mutateGoals(vfs, libraryId, (draft) => {
    const before = draft.goals.length;
    draft.goals = draft.goals.filter((goal) => goal.id !== goalId);
    removed = draft.goals.length !== before;
  });
  return removed;
}

/** 合并节点用：把指向旧根节点的目标改指到新根节点 */
export async function repointGoals(
  vfs: Vfs,
  libraryId: string,
  oldRoot: string,
  newRoot: string,
): Promise<number> {
  let moved = 0;
  await mutateGoals(vfs, libraryId, (draft) => {
    for (const goal of draft.goals) {
      if (goal.rootNodeId !== oldRoot) continue;
      goal.rootNodeId = newRoot;
      moved += 1;
    }
  });
  return moved;
}
