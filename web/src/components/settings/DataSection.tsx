import { useRef } from "react";
import { Download, Upload } from "lucide-react";
import { useApp } from "@/lib/store";
import { useAuth } from "@/lib/auth";
import { listKnown } from "@/lib/srs";
import { exportAll, importAll, resetAll, resetLanguage, type ExportBundle } from "@/lib/db";
import { downloadJson } from "@/lib/download";
import { Card, Button, Divider, SectionLabel, SettingRow as Row } from "@/components/ui/primitives";
import { pluralize } from "@/lib/utils";
import { BRAND } from "@/lib/brand";
import { failMsg } from "./controls";

/** Ajustes → Dados: backup, «já sei», reiniciar idioma, apagar tudo. */
export function DataSection({ notify }: { notify: (msg: string) => void }) {
  const app = useApp();
  // com conta, apagar grava tombstones que sobem: some da conta e dos outros aparelhos
  const signed = useAuth((s) => s.status === "signed");
  const signedWarning = signed ? " — na conta e em todos os aparelhos" : "";
  const fileRef = useRef<HTMLInputElement>(null);

  const doExport = async () => {
    try {
      const bundle = await exportAll();
      downloadJson(`imersa-backup-${new Date().toISOString().slice(0, 10)}.json`, bundle, 2);
      notify("Backup exportado.");
    } catch (e) {
      notify(failMsg("exportar", e));
    }
  };

  /** «Já sei» do idioma, no formato que `dose_factory known --import` lê. */
  const doExportKnown = async () => {
    const lang = app.activeLanguage;
    if (!lang) return;
    try {
      const lemmas = (await listKnown(lang)).map((c) => c.cardId.replace(/^w-/, "")).sort();
      downloadJson(`imersa-ja-sei-${lang}.json`, { language: lang, lemmas }, 1);
      notify(`${lemmas.length} ${pluralize(lemmas.length, "palavra exportada", "palavras exportadas")}.`);
    } catch (e) {
      notify(failMsg("exportar", e));
    }
  };

  const doImport = async (file: File) => {
    try {
      const bundle = JSON.parse(await file.text()) as ExportBundle;
      await importAll(bundle);
      notify("Backup importado. Recarregando…");
      setTimeout(() => location.reload(), 900);
    } catch (e) {
      notify(e instanceof Error ? e.message : "Falha ao importar.");
    }
  };

  const doReset = async () => {
    if (!confirm(`Isso apaga todo o seu progresso (cards, revisões, estatísticas)${signedWarning}. Continuar?`)) return;
    try {
      await resetAll();
    } catch (e) {
      notify(failMsg("apagar o progresso", e));
      return;
    }
    notify("Progresso apagado. Recarregando…");
    setTimeout(() => location.reload(), 700);
  };

  const doResetLang = async () => {
    const lang = app.activeLanguage;
    if (!lang) return;
    if (!confirm(`Isso zera o progresso do idioma atual (${lang})${signedWarning}. Continuar?`)) return;
    try {
      await resetLanguage(lang);
    } catch (e) {
      notify(failMsg("reiniciar o idioma", e));
      return;
    }
    notify("Idioma reiniciado. Recarregando…");
    setTimeout(() => location.reload(), 700);
  };

  return (
    <div className="mt-9">
      <SectionLabel>Dados</SectionLabel>
      <Card className="mt-3 px-5">
        <Row title="Exportar progresso" desc="Backup em JSON">
          <Button variant="secondary" size="sm" onClick={doExport}>
            <Download size={14} /> Exportar
          </Button>
        </Row>
        <Divider />
        <Row title="Importar progresso" desc="Restaura a partir de um backup">
          <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
            <Upload size={14} /> Importar
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && doImport(e.target.files[0])}
          />
        </Row>
        <Divider />
        <Row
          title="Exportar «já sei»"
          desc="As palavras deste idioma que você marcou como conhecidas, para a fábrica de lições não fazer card delas (dose_factory known)"
        >
          <Button variant="secondary" size="sm" onClick={doExportKnown}>
            <Download size={14} /> Exportar
          </Button>
        </Row>
        <Divider />
        <Row title="Reiniciar este idioma" desc="Zera o progresso só do idioma atual">
          <Button variant="secondary" size="sm" onClick={doResetLang}>
            Reiniciar
          </Button>
        </Row>
        <Divider />
        <Row title="Apagar tudo" desc="Remove todo o progresso local, de todos os idiomas">
          <Button variant="danger" size="sm" onClick={doReset}>
            Apagar
          </Button>
        </Row>
      </Card>
      <p className="mt-3 max-w-[62ch] px-1 text-xs leading-relaxed text-faint">
        O {BRAND.name} guarda tudo no seu navegador (IndexedDB) e funciona offline. Com uma
        conta, o mesmo progresso aparece em todos os aparelhos; o backup em arquivo continua
        valendo como cópia de segurança.
      </p>
    </div>
  );
}
