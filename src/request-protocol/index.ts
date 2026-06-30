import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";

import { chromium } from "@playwright/test";

import { listRequestProtocolProjects } from "../database/queries";
import { requestProtocolOnNewCelesc } from "./celesc";
import {
  createSucceededProtocolResult,
  createSystemProtocolReport,
} from "./report";
import type { ProtocolResult } from "./report";
import { requestProtocolOnNewTopsun } from "./topsun";

export type Project = Awaited<
  ReturnType<typeof listRequestProtocolProjects>
>[number];

async function shouldProceedWithProjects() {
  const readlineInterface = readline.createInterface({ input, output });

  try {
    const answer = await readlineInterface.question("Deseja continuar? (s/N) ");
    return answer.trim().toLowerCase() === "s";
  } finally {
    readlineInterface.close();
  }
}

export async function runRequestProtocol() {
  const projects = await listRequestProtocolProjects();

  if (projects.length === 0) {
    console.log("Nenhum projeto encontrado.");
    process.exit(0);
  }

  console.log(`Encontrados ${projects.length} projetos para automação.`);
  console.table(
    // oxlint-disable-next-line sort-keys
    projects.map(({ cidadeInstalacao, cliente, concessionaria, projeto }) => ({
      projeto,
      cliente,
      cidade: cidadeInstalacao,
      concessionaria,
    }))
  );

  const shouldProceed = await shouldProceedWithProjects();

  if (!shouldProceed) {
    console.log("Automação cancelada.");
    process.exit(0);
  }

  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH,
    headless: false,
  });

  try {
    const celescResults = await Promise.all(
      projects.map(async (project): Promise<ProtocolResult> => {
        const succeeded = await requestProtocolOnNewCelesc(browser, project);

        if (succeeded) {
          return createSucceededProtocolResult(project);
        }

        return {
          errorMessage: "Erro ao solicitar protocolo na CELESC.",
          project,
          status: "ERRORED",
        };
      })
    );

    await createSystemProtocolReport({
      outputPath: "logs/celesc-report.xlsx",
      results: celescResults,
      system: "CELESC",
    });

    const succeededProjects = celescResults.flatMap(({ project, status }) =>
      status === "SUCCEEDED" ? [project] : []
    );

    console.log(
      `\n${succeededProjects.length} protocolo(s) solicitado(s) com sucesso na CELESC\n`
    );

    const topsunResults = await requestProtocolOnNewTopsun(
      browser,
      succeededProjects
    );

    await createSystemProtocolReport({
      outputPath: "logs/topsun-report.xlsx",
      results: topsunResults,
      system: "TOPSUN",
    });

    console.log(
      "\nRelatórios gerados em logs/celesc-report.xlsx e logs/topsun-report.xlsx\n"
    );
  } finally {
    await browser.close();
  }

  process.exit(0);
}
