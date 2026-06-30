import type { Browser, BrowserContext, Page } from "@playwright/test";

import type { Project } from ".";
import {
  createErroredProtocolResult,
  createSucceededProtocolResult,
} from "./report";
import type { ProtocolResult } from "./report";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CONCURRENCY = 3;
const BROWSER_CLOSE_TIMEOUT_MS = 5000;
const MAX_PROJECT_ATTEMPTS = 3;
const PROTOCOLO_SOLICITADO_LABEL = "PROTOCOLO SOLICITADO [R]";

const SELECTORS = {
  closeModalEtapa: "#fecharModalEtapa",
  coletaFiltro: "#coleta_filtro",
  coletaFiltroLoading: "#div_coleta_filtro_carregando",
  dataEtapa: 'input[name="data"]',
  etapaSolicitacaoProtocoloText: "#etapa-42 .etapa-text",
  modalEtapa: "#ModalEtapa",
  observacao: "textarea[name='observacao']",
  passwordInput: 'input[name="senha"]',
  swalConfirmButton: "button.swal2-confirm.swal2-styled",
  swalContainer: ".swal2-container",
  usernameInput: 'input[name="usuario"]',
} as const;

function getTopsunConcurrency() {
  const parsed = Number(process.env.TOPSUN_CONCURRENCY);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_CONCURRENCY;
  }

  return Math.floor(parsed);
}

// Autentica no sistema quando a sessão expirou
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
async function waitForColetaFiltroToLoad(page: Page, _project: Project) {
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
async function selectProject(page: Page, project: Project) {
  await setHiddenSelectValue(
    page,
    SELECTORS.coletaFiltro,
    String(project.projeto)
  );

  await page.getByRole("button", { name: "Filtrar" }).click();
}

// Abre o modal da etapa "Solicitação de Protocolo"
async function openRequestProtocolModal(page: Page, _project: Project) {
  const solicitacaoProtocoloEtapa = page.locator(
    SELECTORS.etapaSolicitacaoProtocoloText
  );

  await solicitacaoProtocoloEtapa.waitFor();
  await solicitacaoProtocoloEtapa.click();

  await page.getByRole("button", { name: "Salvar Registros" }).waitFor();
}

function buildCurrentDateText() {
  return new Intl.DateTimeFormat("pt-BR").format(new Date());
}

function buildProtocoloSolicitadoText() {
  return `${buildCurrentDateText()} - ${PROTOCOLO_SOLICITADO_LABEL}`;
}

// Preenche a observação com a data da solicitação de protocolo
async function fillRequestProtocolModal(page: Page) {
  const dataEtapa = page.locator(SELECTORS.dataEtapa);
  const observacao = page.locator(SELECTORS.observacao);

  await dataEtapa.fill(buildCurrentDateText());

  const protocoloSolicitadoText = buildProtocoloSolicitadoText();
  const currentObservacao = await observacao.inputValue();

  if (currentObservacao.includes(protocoloSolicitadoText)) {
    return;
  }

  await observacao.fill(
    currentObservacao
      ? `${currentObservacao}\n${protocoloSolicitadoText}`
      : protocoloSolicitadoText
  );
}

async function saveRequestProtocolStep(page: Page, _project: Project) {
  await page.getByRole("button", { name: "Salvar Registros" }).click();

  await page.locator(SELECTORS.swalConfirmButton).waitFor();
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

async function runTopsunProjectAttempt(
  browser: Browser,
  project: Project
): Promise<ProtocolResult> {
  let context: BrowserContext | undefined;
  let page: Page | undefined;

  try {
    context = await browser.newContext();
    page = await context.newPage();

    page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);

    await authenticate(page);
    await waitForColetaFiltroToLoad(page, project);
    await selectProject(page, project);
    await openRequestProtocolModal(page, project);
    await fillRequestProtocolModal(page);
    await saveRequestProtocolStep(page, project);

    console.log(
      `✅ Protocolo registrado na Topsun:\t${project.projeto} - ${project.cliente}`
    );

    return createSucceededProtocolResult(project);
  } catch (error) {
    console.error(
      `❌ Erro ao registrar protocolo na Topsun:\t${project.projeto} - ${project.cliente}`
    );

    return createErroredProtocolResult(project, error);
  } finally {
    await closeContextSafely(page, context);
  }
}

async function requestProtocolOnNewTopsunProject(
  browser: Browser,
  project: Project,
  attempt = 1
): Promise<ProtocolResult> {
  if (attempt > 1) {
    console.log(
      `🚨 Retentando automação do projeto:\t${project.projeto} - ${project.cliente} (tentativa ${attempt}/${MAX_PROJECT_ATTEMPTS})`
    );
  }

  const result = await runTopsunProjectAttempt(browser, project);

  if (result.status === "SUCCEEDED" || attempt >= MAX_PROJECT_ATTEMPTS) {
    return result;
  }

  return requestProtocolOnNewTopsunProject(browser, project, attempt + 1);
}

async function processProjectsWithConcurrency(
  browser: Browser,
  projects: Project[],
  concurrency: number
) {
  const results: ProtocolResult[] = [];
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
        `📣 Iniciando automação do projeto:\t${project.projeto} - ${project.cliente}`
      );

      try {
        results[currentIndex] = await requestProtocolOnNewTopsunProject(
          browser,
          project
        );
      } catch (error) {
        console.error(
          `❌ Erro inesperado no worker da Topsun:\t${project.projeto} - ${project.cliente}`,
          error
        );

        results[currentIndex] = createErroredProtocolResult(project, error);
      }
    }
  }

  const workerCount = Math.min(concurrency, projects.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}

export function requestProtocolOnNewTopsun(
  browser: Browser,
  projects: Project[]
) {
  if (projects.length === 0) {
    return Promise.resolve([]);
  }

  const concurrency = getTopsunConcurrency();

  console.log(
    `\nProcessando ${projects.length} projeto(s) na Topsun com concorrência ${concurrency}\n`
  );

  return processProjectsWithConcurrency(browser, projects, concurrency);
}
