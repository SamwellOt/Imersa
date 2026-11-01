/** Baixa `data` como arquivo JSON (`indent` = recuo do JSON.stringify). */
export function downloadJson(filename: string, data: unknown, indent: number): void {
  const blob = new Blob([JSON.stringify(data, null, indent)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  // o link precisa estar no documento (Firefox ignora o clique fora dele) e a
  // URL só pode ser revogada depois que o download começou
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 5000);
}
