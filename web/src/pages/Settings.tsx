import { useEffect, useState } from "react";
import { Moon, Sun, Smartphone } from "lucide-react";
import { useDocumentTitle } from "@/lib/hooks";
import { SYNC_EVENT } from "@/lib/sync";
import { useApp } from "@/lib/store";
import { getSrsSettings, saveSrsSettings, type SrsSettings } from "@/lib/srs";
import { Card, Button, SectionLabel, SettingRow as Row } from "@/components/ui/primitives";
import { AccountSection } from "@/components/settings/AccountSection";
import { ImmersionSection } from "@/components/settings/ImmersionSection";
import { SrsSection } from "@/components/settings/SrsSection";
import { FsrsSection } from "@/components/settings/FsrsSection";
import { DataSection } from "@/components/settings/DataSection";
import { useInstallPrompt } from "@/components/settings/useInstallPrompt";
import { Segmented } from "@/components/ui/Segmented";
import { BRAND } from "@/lib/brand";

export function Settings() {
  useDocumentTitle("Ajustes · " + BRAND.name);
  const app = useApp();
  const { canInstall, installed, install } = useInstallPrompt();
  const [srs, setSrs] = useState<SrsSettings | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    getSrsSettings().then(setSrs);
  }, []);
  // Uma sincronização que trouxe `srs` de outro aparelho (ex.: parâmetros FSRS
  // otimizados) precisa aparecer aqui — senão a tela segue mostrando o snapshot.
  useEffect(() => {
    const onSynced = (e: Event) => {
      const detail = (e as CustomEvent<{ received?: number }>).detail;
      if (detail?.received) void getSrsSettings().then(setSrs);
    };
    addEventListener(SYNC_EVENT, onSynced);
    return () => removeEventListener(SYNC_EVENT, onSynced);
  }, []);
  const saveSrs = async (patch: Partial<SrsSettings>) => {
    // a gravação fica FORA do updater: em StrictMode o updater roda duas vezes
    // e escrevia o ajuste duas vezes no banco (duas mudanças para sincronizar).
    setSrs(await saveSrsSettings(patch));
  };

  const notify = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(null), 2500);
  };

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="page-title">Ajustes</h1>

      {/* Conta — no topo: é quem você é e onde o progresso mora */}
      <AccountSection notify={notify} />

      {/* Aparência */}
      <div className="mt-9">
        <SectionLabel>Aparência</SectionLabel>
        <Card className="mt-3 px-5">
          <Row title="Tema">
            <Segmented
              value={app.theme}
              onChange={app.setTheme}
              options={[
                { value: "dark", label: "Escuro", icon: <Moon size={13} /> },
                { value: "light", label: "Claro", icon: <Sun size={13} /> },
              ]}
              size="sm"
            />
          </Row>
        </Card>
      </div>

      {/* App */}
      {(canInstall || installed) && (
        <div className="mt-9">
          <SectionLabel>Aplicativo</SectionLabel>
          <Card className="mt-3 px-5">
            <Row
              title={installed ? "Instalado" : "Instalar o Imersa"}
              desc={
                installed
                  ? "Rodando como app. O conteúdo já visto funciona offline."
                  : "Abre em janela própria, com ícone. Funciona offline (menos o vídeo)."
              }
            >
              {installed ? (
                <span className="inline-flex items-center gap-1.5 text-sm text-good">
                  <Smartphone size={14} /> Ativo
                </span>
              ) : (
                <Button variant="secondary" size="sm" onClick={install}>
                  <Smartphone size={14} /> Instalar
                </Button>
              )}
            </Row>
          </Card>
        </div>
      )}

      <ImmersionSection />

      <SrsSection srs={srs} saveSrs={saveSrs} />

      <FsrsSection srs={srs} saveSrs={saveSrs} notify={notify} />

      <DataSection notify={notify} />

      {flash && (
        <div className="elev-2 fixed inset-x-0 bottom-24 z-50 mx-auto w-fit rounded-lg border border-line bg-surface px-3.5 py-2 text-sm font-medium md:bottom-8">
          {flash}
        </div>
      )}
    </div>
  );
}
