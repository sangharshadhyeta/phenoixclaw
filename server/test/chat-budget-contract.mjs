/**
 * How much a conversation may do before it has to hand the work out.
 *
 * The after-turn check catches a chat that did the work itself, and a live run
 * showed the limit of catching: it fired, the model read "hand it out next
 * time", agreed with the principle, and answered anyway. By the time the check
 * runs the work is finished, so all a hand-back can buy is a promise.
 *
 * The moment that decides whether work happens in the chat is the moment
 * before the fifth tool call, which makes it a guard.
 *
 *     npm run test:chat-budget
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { overChatBudget, resetChatBudget, CHAT_BUDGET_REFUSAL } = await import(
  path.join(here, "..", "dist", "pi", "chat-budget.js")
);

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

// --- the budget -------------------------------------------------------------
{
  resetChatBudget("s1");
  const over = [];
  for (let i = 0; i < 6; i++) over.push(overChatBudget("s1", "bash"));
  ok("a few calls are free", over.slice(0, 4).every((x) => !x));
  ok("and past that it stops", over[4] === true && over[5] === true);

  // Each turn starts again, or a long conversation would seize up.
  resetChatBudget("s1");
  ok("a new turn gets the budget back", !overChatBudget("s1", "bash"));

  resetChatBudget("s2");
  ok("budgets are per session", !overChatBudget("s2", "bash"));
}

// --- what does not count ----------------------------------------------------
{
  resetChatBudget("s3");
  // Handing out is the desired outcome and must never be the thing that
  // pushes a conversation over the edge.
  for (let i = 0; i < 20; i++) overChatBudget("s3", "start_task");
  ok("handing work out is never over budget", !overChatBudget("s3", "start_task"));
  ok("nor is following up on it", !overChatBudget("s3", "tell_task"));

  resetChatBudget("s4");
  for (let i = 0; i < 20; i++) overChatBudget("s4", "graph_recall");
  ok("nor is reading its own memory", !overChatBudget("s4", "graph_recall"));
  ok("nor asking what is running", !overChatBudget("s4", "tasks_running"));
  // But a real call after all of those still counts from zero.
  ok("and free calls did not consume the budget", !overChatBudget("s4", "bash"));
}

// --- what it says -----------------------------------------------------------
{
  ok("the refusal names the tool to use", /start_task/.test(CHAT_BUDGET_REFUSAL));
  // The calls already made are in its context and are worth something.
  ok("and says to use what it has learned", /You know more than you did when this started/.test(CHAT_BUDGET_REFUSAL));
  // Otherwise a model with the answer would start a pointless task to say it.
  ok("having the answer already is an out", /you do not need another tool call for that/.test(CHAT_BUDGET_REFUSAL));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
