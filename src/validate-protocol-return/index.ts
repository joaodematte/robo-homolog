import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";

import { google } from "googleapis";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";

import {
  getColetaDadosByUnidadeConsumidora,
  listOpenProtocolProjectsByClientNames,
} from "../database/queries";
import {
  createProtocolReturnDivergenceReport,
  createProtocolReturnReport,
} from "./report";

type ProtocoloEmail =
  | {
      nomeCliente: string;
      numeroProtocolo: string;
      status: "scraped";
    }
  | {
      status: "not_scraped";
    };

type NotOkProtocoloEmail =
  | {
      motivoDivergencia: string;
      unidadeConsumidora: string;
      status: "scraped";
    }
  | {
      status: "not_scraped";
    };

interface ScrapedProtocolEntry {
  dataEmail: string;
  nomeCliente: string;
  numeroProtocolo: string;
}

interface OpenProjectWithProtocol {
  idColeta: number | null;
  nomeCliente: string | null;
  numeroProtocolo: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CONCURRENCY = 3;
const BROWSER_CLOSE_TIMEOUT_MS = 5000;
const MAX_PROJECT_ATTEMPTS = 3;

const PROTOCOL_RETURN_REPORT_PATH =
  "logs/retorno-protocolo/retorno-protocolo.xlsx";
const PROTOCOL_RETURN_DIVERGENCE_REPORT_PATH =
  "logs/retorno-protocolo/retorno-protocolo-divergencia.xlsx";
const PROTOCOL_RETURN_FAILURE_LOG_PATH =
  "logs/retorno-protocolo/retorno-protocolo-falha-robo.txt";

const SELECTORS = {
  closeModalEtapa: "#fecharModalEtapa",
  coletaFiltro: "#coleta_filtro",
  coletaFiltroLoading: "#div_coleta_filtro_carregando",
  dataEtapa: 'input[name="data"]',
  etapaSolicitacaoProtocoloText: "#etapa-42 .etapa-text",
  etapaSolicitacaoProtocoloVerde: "#etapa-42 .etapa-verde",
  modalEtapa: "#ModalEtapa",
  numeroProtocolo: "input[name='campopadrao']",
  passwordInput: 'input[name="senha"]',
  swalConfirmButton: "button.swal2-confirm.swal2-styled",
  swalContainer: ".swal2-container",
  usernameInput: 'input[name="usuario"]',
} as const;

const auth = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);

auth.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
});

const gmail = google.gmail({
  auth,
  version: "v1",
});

async function shouldProceedWithProjects() {
  const readlineInterface = readline.createInterface({ input, output });

  try {
    const answer = await readlineInterface.question("Deseja continuar? (s/N) ");
    return answer.trim().toLowerCase() === "s";
  } finally {
    readlineInterface.close();
  }
}

async function closeContextSafely(
  page: Page | undefined,
  context: BrowserContext | undefined
) {
  const closePromise = async () => {
    try {
      await page?.close({ runBeforeUnload: false });
    } catch {
      // Ignora falha ao fechar a página
    }

    try {
      await context?.close();
    } catch {
      // Ignora falha ao fechar o contexto
    }
  };

  await Promise.race([closePromise(), Bun.sleep(BROWSER_CLOSE_TIMEOUT_MS)]);
}

function getTopsunConcurrency() {
  const parsed = Number(process.env.TOPSUN_CONCURRENCY);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_CONCURRENCY;
  }

  return Math.floor(parsed);
}

function extractProtocolInfo(body: string): ProtocoloEmail {
  const match = body.match(
    /cliente\s+(?<nomeCliente>.+?)\s+indicou seu endereço de e-mail.*?protocolo\s+(?<numeroProtocolo>\d+)/u
  );

  if (!match || !match.groups?.nomeCliente || !match.groups?.numeroProtocolo) {
    return {
      status: "not_scraped",
    };
  }

  return {
    nomeCliente: match.groups.nomeCliente.trim(),
    numeroProtocolo: match.groups.numeroProtocolo.trim(),
    status: "scraped",
  };
}

function cleanExtractedText(text: string) {
  return text
    .replaceAll(/<[^>]+>/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function normalizeClientName(name: string) {
  return name
    .normalize("NFD")
    .replaceAll(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function findProtocolEntryForClientName(
  clientName: string | null,
  scrapedEntries: ScrapedProtocolEntry[]
) {
  if (!clientName) {
    return;
  }

  const normalizedClientName = normalizeClientName(clientName);

  return scrapedEntries.find((entry) => {
    const normalizedEntryName = normalizeClientName(entry.nomeCliente);

    return (
      normalizedClientName.includes(normalizedEntryName) ||
      normalizedEntryName.includes(normalizedClientName)
    );
  });
}

function extractNotOkProtocolInfo(body: string): NotOkProtocoloEmail {
  const match = body.match(
    /unidade consumidora\s+(?<unidadeConsumidora>\d+)[\s\S]*?divergência\(s\):\s*(?<motivoDivergencia>[\s\S]+?)<\/span>/iu
  );

  if (!match?.groups?.unidadeConsumidora || !match.groups.motivoDivergencia) {
    return {
      status: "not_scraped",
    };
  }

  return {
    motivoDivergencia: cleanExtractedText(match.groups.motivoDivergencia),
    status: "scraped",
    unidadeConsumidora: match.groups.unidadeConsumidora.trim(),
  };
}

function getEmailBody(
  email: NonNullable<Awaited<ReturnType<typeof getEmails>>[number]>
) {
  return Buffer.from(
    email.data.payload?.body?.data ?? "",
    "base64url"
  ).toString("utf-8");
}

function getEmailDate(
  email: NonNullable<Awaited<ReturnType<typeof getEmails>>[number]>
) {
  const internalDate = Number(email.data.internalDate);

  if (!Number.isFinite(internalDate)) {
    return "";
  }

  return new Intl.DateTimeFormat("pt-BR").format(new Date(internalDate));
}

async function getEmails(query: string) {
  const { data } = await gmail.users.messages.list({
    q: query,
    userId: "me",
  });

  return Promise.all(
    (data.messages ?? []).map(async ({ id }) => {
      if (!id) {
        return null;
      }

      const emailData = await gmail.users.messages.get({
        id,
        userId: "me",
      });

      return emailData;
    })
  );
}

async function writeFailureLog(outputPath: string, emailBodies: string[]) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, emailBodies.join("\n----\n"), "utf-8");
}

async function authenticate(page: Page) {
  await page.goto("https://sistematopsun.com.br");

  const usernameInput = page.locator(SELECTORS.usernameInput);
  const passwordInput = page.locator(SELECTORS.passwordInput);
  const entrarButton = page.locator("button#btn_entrar");

  await usernameInput.waitFor();
  await passwordInput.waitFor();
  await entrarButton.waitFor();

  await usernameInput.fill(process.env.TOPSUN_USERNAME ?? "");
  await passwordInput.fill(process.env.TOPSUN_PASSWORD ?? "");
  await entrarButton.click();

  await usernameInput.waitFor({ state: "hidden" });
  await page.goto(process.env.TOPSUN_ETAPAS_PAGE ?? "");
}

// Aguarda o carregamento assíncrono das opções do filtro de projetos
async function waitForColetaFiltroToLoad(page: Page) {
  await page
    .locator(SELECTORS.coletaFiltroLoading)
    .waitFor({ state: "hidden" });
}

// Define o valor de um select oculto e dispara o evento change do Chosen
async function setHiddenSelectValue(
  page: Page,
  selector: string,
  value: string
) {
  await page.locator(selector).evaluate((element, selectedValue) => {
    const selectElement = element as {
      dispatchEvent: (event: Event) => boolean;
      value: string;
    };

    selectElement.value = selectedValue;
    selectElement.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

// Seleciona o projeto no filtro e aplica a busca
async function selectProject(page: Page, idColeta: number) {
  await setHiddenSelectValue(page, SELECTORS.coletaFiltro, String(idColeta));

  await page.getByRole("button", { name: "Filtrar" }).click();
}

// Abre o modal da etapa "Solicitação de Protocolo"
async function openRequestProtocolModal(page: Page) {
  const solicitacaoProtocoloEtapa = page.locator(
    SELECTORS.etapaSolicitacaoProtocoloText
  );

  await solicitacaoProtocoloEtapa.waitFor();
  await solicitacaoProtocoloEtapa.click();

  await page.getByRole("button", { name: "Salvar Registros" }).waitFor();
}

async function fillRequestProtocolModal(
  page: Page,
  idColeta: number,
  nomeCliente: string,
  numeroProtocolo: string
) {
  const dataEtapa = page.locator(SELECTORS.dataEtapa);
  const dataInputValue = await dataEtapa.inputValue();
  const dataValue = dataInputValue.trim();

  if (!dataValue) {
    console.error(
      `❌ Erro ao fechar etapa na Topsun:\t${idColeta} - ${nomeCliente} - SEM DATA PREENCHIDA`
    );
    throw new Error("SEM DATA PREENCHIDA");
  }

  const numeroProtocoloInput = page.locator(SELECTORS.numeroProtocolo);

  const currentNumeroProtocolo = await numeroProtocoloInput.inputValue();

  if (currentNumeroProtocolo.includes(numeroProtocolo)) {
    console.log(
      `✅ Número de protocolo já preenchido para o projeto ${idColeta}`
    );
    return;
  }

  await numeroProtocoloInput.fill(
    currentNumeroProtocolo
      ? `${currentNumeroProtocolo} | ${numeroProtocolo}`
      : numeroProtocolo
  );
}

async function saveRequestProtocolStep(page: Page) {
  await page.getByRole("button", { name: "Salvar Registros" }).click();

  const confirmButton = page
    .locator(SELECTORS.swalConfirmButton)
    .filter({ hasText: "Sim" });
  await confirmButton.waitFor();
  await confirmButton.click();

  await page.locator(SELECTORS.etapaSolicitacaoProtocoloVerde).waitFor();
}

async function runCloseEtapaAttempt(
  browser: Browser,
  project: OpenProjectWithProtocol
): Promise<boolean> {
  let context: BrowserContext | undefined;
  let page: Page | undefined;

  if (!project.idColeta || !project.nomeCliente) {
    return false;
  }

  try {
    context = await browser.newContext();
    page = await context.newPage();

    page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);

    await authenticate(page);
    await waitForColetaFiltroToLoad(page);
    await selectProject(page, project.idColeta);
    await openRequestProtocolModal(page);
    await fillRequestProtocolModal(
      page,
      project.idColeta,
      project.nomeCliente,
      project.numeroProtocolo
    );
    await saveRequestProtocolStep(page);

    console.log(
      `✅ Etapa fechada na Topsun:\t${project.idColeta} - ${project.nomeCliente}`
    );

    return true;
  } catch (error) {
    if (!(error instanceof Error && error.message === "SEM DATA PREENCHIDA")) {
      console.error(
        `❌ Erro ao fechar etapa na Topsun:\t${project.idColeta} - ${project.nomeCliente}`
      );
    }

    return false;
  } finally {
    await closeContextSafely(page, context);
  }
}

async function closeEtapaOnTopsunWithRetry(
  browser: Browser,
  project: OpenProjectWithProtocol,
  attempt = 1
): Promise<boolean> {
  if (attempt > 1) {
    console.log(
      `🚨 Retentando fechamento de etapa:\t${project.idColeta} - ${project.nomeCliente} (tentativa ${attempt}/${MAX_PROJECT_ATTEMPTS})`
    );
  }

  const succeeded = await runCloseEtapaAttempt(browser, project);

  if (succeeded || attempt >= MAX_PROJECT_ATTEMPTS) {
    return succeeded;
  }

  return closeEtapaOnTopsunWithRetry(browser, project, attempt + 1);
}

async function processProtocolReturnsWithConcurrency(
  browser: Browser,
  projects: OpenProjectWithProtocol[],
  concurrency: number
) {
  const results: boolean[] = [];
  let nextProjectIndex = 0;

  async function worker() {
    /* oxlint-disable no-await-in-loop -- cada worker consome a fila em sequência */
    while (nextProjectIndex < projects.length) {
      const currentIndex = nextProjectIndex;
      nextProjectIndex += 1;

      const project = projects[currentIndex];

      if (!project) {
        continue;
      }

      console.log(
        `📣 Iniciando fechamento de etapa:\t${project.idColeta} - ${project.nomeCliente}`
      );

      try {
        results[currentIndex] = await closeEtapaOnTopsunWithRetry(
          browser,
          project
        );
      } catch (error) {
        console.error(
          `❌ Erro inesperado no worker de retorno de protocolo:\t${project.idColeta} - ${project.nomeCliente}`,
          error
        );

        results[currentIndex] = false;
      }
    }
  }

  const workerCount = Math.min(concurrency, projects.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}

function closeProtocolReturnsOnTopsun(
  browser: Browser,
  projects: OpenProjectWithProtocol[]
) {
  if (projects.length === 0) {
    return Promise.resolve([]);
  }

  const concurrency = getTopsunConcurrency();

  console.log(
    `\nProcessando ${projects.length} retorno(s) de protocolo na Topsun com concorrência ${concurrency}\n`
  );

  return processProtocolReturnsWithConcurrency(browser, projects, concurrency);
}

export async function validateProtocolReturn() {
  const [okEmails, notOkEmails] = await Promise.all([
    getEmails("newer_than:14d from:nao-responda@celesc.com.br"),
    getEmails("newer_than:14d from:naoresponda@celesc.com.br"),
  ]);

  const scrapedEntries: ScrapedProtocolEntry[] = [];
  const failedEmailBodies: string[] = [];
  const notOkScrapedEntries: {
    dataEmail: string;
    motivoDivergencia: string;
    unidadeConsumidora: string;
  }[] = [];

  for (const email of okEmails) {
    if (!email) {
      continue;
    }

    const body = getEmailBody(email);
    const protocolInfo = extractProtocolInfo(body);

    if (protocolInfo.status === "scraped") {
      scrapedEntries.push({
        dataEmail: getEmailDate(email),
        nomeCliente: protocolInfo.nomeCliente,
        numeroProtocolo: protocolInfo.numeroProtocolo,
      });
      continue;
    }

    failedEmailBodies.push(body);
  }

  for (const email of notOkEmails) {
    if (!email) {
      continue;
    }

    const body = getEmailBody(email);
    const protocolInfo = extractNotOkProtocolInfo(body);

    if (protocolInfo.status === "scraped") {
      notOkScrapedEntries.push({
        dataEmail: getEmailDate(email),
        motivoDivergencia: protocolInfo.motivoDivergencia,
        unidadeConsumidora: protocolInfo.unidadeConsumidora,
      });
    }
  }

  await createProtocolReturnReport({
    entries: scrapedEntries,
    outputPath: PROTOCOL_RETURN_REPORT_PATH,
  });

  const divergenceReportEntries = await Promise.all(
    notOkScrapedEntries.map(async (entry) => {
      const [coleta] = await getColetaDadosByUnidadeConsumidora(
        entry.unidadeConsumidora
      );

      return {
        cliente: coleta?.nomeCliente ?? "",
        dataEmail: entry.dataEmail,
        motivoDivergencia: entry.motivoDivergencia,
        projeto: coleta?.idColeta ?? "",
        uc: entry.unidadeConsumidora,
      };
    })
  );

  await createProtocolReturnDivergenceReport({
    entries: divergenceReportEntries,
    outputPath: PROTOCOL_RETURN_DIVERGENCE_REPORT_PATH,
  });

  if (failedEmailBodies.length > 0) {
    await writeFailureLog(PROTOCOL_RETURN_FAILURE_LOG_PATH, failedEmailBodies);
  }

  console.log(
    `\n✅ Relatório gerado em ${PROTOCOL_RETURN_REPORT_PATH} com ${scrapedEntries.length} protocolo(s).`
  );
  console.log(
    `⚠️ Relatório de divergências gerado em ${PROTOCOL_RETURN_DIVERGENCE_REPORT_PATH} com ${notOkScrapedEntries.length} unidade(s) consumidora(s).\n`
  );

  if (failedEmailBodies.length > 0) {
    console.log(
      `❌ ${failedEmailBodies.length} e-mail(s) não processado(s) em ${PROTOCOL_RETURN_FAILURE_LOG_PATH}.\n`
    );
  }

  const openProjects = await listOpenProtocolProjectsByClientNames(
    scrapedEntries.map((entry) => entry.nomeCliente)
  );

  const openProjectsWithProtocol = openProjects.flatMap((openProject) => {
    const protocolEntry = findProtocolEntryForClientName(
      openProject.nomeCliente,
      scrapedEntries
    );

    if (!protocolEntry) {
      return [];
    }

    return {
      ...openProject,
      numeroProtocolo: protocolEntry.numeroProtocolo,
    };
  });

  if (openProjectsWithProtocol.length === 0) {
    console.log("Nenhum projeto aberto encontrado para fechamento de etapa.");
    process.exit(0);
  }

  console.log(
    `Encontrados ${openProjectsWithProtocol.length} projetos para fechamento de etapa.`
  );
  console.table(
    // oxlint-disable-next-line sort-keys
    openProjectsWithProtocol.map(
      ({ idColeta, nomeCliente, numeroProtocolo }) => ({
        cliente: nomeCliente,
        numeroProtocolo,
        projeto: idColeta,
      })
    )
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
    await closeProtocolReturnsOnTopsun(browser, openProjectsWithProtocol);
  } finally {
    await browser.close();
  }

  process.exit(0);
}
