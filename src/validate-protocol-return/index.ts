import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { google } from "googleapis";

import { getColetaDadosByUnidadeConsumidora } from "../database/queries";
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

const PROTOCOL_RETURN_REPORT_PATH =
  "logs/retorno-protocolo/retorno-protocolo.xlsx";
const PROTOCOL_RETURN_DIVERGENCE_REPORT_PATH =
  "logs/retorno-protocolo/retorno-protocolo-divergencia.xlsx";
const PROTOCOL_RETURN_FAILURE_LOG_PATH =
  "logs/retorno-protocolo/retorno-protocolo-falha-robo.txt";

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

export async function validateProtocolReturn() {
  const [okEmails, notOkEmails] = await Promise.all([
    getEmails("newer_than:14d from:nao-responda@celesc.com.br"),
    getEmails("newer_than:14d from:naoresponda@celesc.com.br"),
  ]);

  const scrapedEntries: {
    dataEmail: string;
    nomeCliente: string;
    numeroProtocolo: string;
  }[] = [];
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

  process.exit(0);
}
