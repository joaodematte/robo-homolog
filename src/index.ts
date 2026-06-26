import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";

import { runRequestProtocol } from "./request-protocol";
import { validateProtocolReturn } from "./validate-protocol-return";

async function askAutomationChoice() {
  console.log("Qual automação você deseja iniciar?");
  console.log("1️⃣ - Solicitação de Protocolo");
  console.log("2️⃣ - Retorno de Protocolo");

  const readlineInterface = readline.createInterface({ input, output });

  try {
    const answer = await readlineInterface.question("");
    return answer.trim();
  } finally {
    readlineInterface.close();
  }
}

async function runAutomationMenu() {
  const choice = await askAutomationChoice();

  switch (choice) {
    case "1": {
      await runRequestProtocol();
      break;
    }
    case "2": {
      await validateProtocolReturn();
      break;
    }
    default: {
      process.exit(0);
    }
  }
}

await runAutomationMenu();
