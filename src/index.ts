import process from "node:process";
import readline from "node:readline";
import path from "node:path";
import { loadConfig } from "./config/index.js";
import { type AgentEventHandlers } from "./agent/index.js";
import { Session } from "./session.js";
import { ReplController, resultLines } from "./repl.js";
import { parseArgs, type ParsedArgs } from "./args.js";

function resolveAsk(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

const replEvents: AgentEventHandlers = {
  onText(t) {
    process.stdout.write(t);
  },
  onToolStart(call) {
    if (call.name === "run_command") {
      process.stderr.write(
        `\n⚠ run_command runs with your OS user permissions (it is not a sandbox). Review the command before approving.\n`,
      );
    }
    process.stdout.write(`\n[${call.name}] ${JSON.stringify(call.arguments)}\n`);
  },
  onToolResult(_call, resultText) {
    if (resultText.length <= 400) process.stdout.write(`  ${resultText}\n`);
  },
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    console.error("Run with --help for usage.");
    process.exit(1);
  }
  if (args.version) {
    console.log("OpenPluseXYZ 0.1.0");
    process.exit(0);
  }
  if (args.help) {
    console.log(
      [
        "OpenPluseXYZ — terminal AI coding agent",
        "",
        "Usage:",
        "  openplusexyz <prompt...>        run a single task",
        "  openplusexyz                     start an interactive REPL",
        "  openplusexyz --cwd <dir>         work in a different directory",
        "  openplusexyz --provider <name>   override provider (openrouter, gemini, ollama)",
        "  openplusexyz --model <model>     override the model",
      ].join("\n"),
    );
    process.exit(0);
  }

  const cwd = args.cwd ? path.resolve(args.cwd) : process.cwd();
  const providerOverride = args.provider;
  const modelOverride = args.model;

  const cfg = await loadConfig({ cwd });
  if (providerOverride) cfg.provider = providerOverride;
  if (modelOverride) cfg.model = modelOverride;

  const session = await Session.create(cfg, cwd, { resolveAsk, events: replEvents });

  if (args.prompt.length > 0) {
    const run = await session.runTurn(args.prompt.join(" "), []);
    for (const out of resultLines(run)) console.log(out);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`OpenPluseXYZ — working in ${cwd} (provider: ${session.activeProvider})`);
  console.log(`Type /help for commands.`);

  const repl = new ReplController(session);

  const welcome = () => rl.prompt();
  rl.setPrompt("OpenPluseXYZ ❯ ");
  rl.on("line", async (line) => {
    const { exit, output } = await repl.handleLine(line);
    for (const out of output) console.log(out);
    if (exit) {
      rl.close();
      return;
    }
    welcome();
  });
  rl.on("close", () => {
    process.stdout.write("\nbye\n");
    process.exit(0);
  });
  welcome();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
