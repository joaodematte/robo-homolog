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

export async function runRequestProtocol() {
  const projects = await listRequestProtocolProjects();

  if (projects.length === 0) {
    console.log("Nenhum projeto encontrado.");
    process.exit(0);
  }

  console.log(`Encontrados ${projects.length} projetos para automação.`);

  const celescResults = await Promise.all(
    projects.map(async (project): Promise<ProtocolResult> => {
      const succeeded = await requestProtocolOnNewCelesc(project);

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

  const topsunResults = await requestProtocolOnNewTopsun(succeededProjects);

  await createSystemProtocolReport({
    outputPath: "logs/topsun-report.xlsx",
    results: topsunResults,
    system: "TOPSUN",
  });

  console.log(
    "\nRelatórios gerados em logs/celesc-report.xlsx e logs/topsun-report.xlsx\n"
  );

  process.exit(0);
}
