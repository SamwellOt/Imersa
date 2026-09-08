// Loads static content (index/course/dose) served from /content and resolves
// media paths (which are relative to each dose folder).
import type { ContentIndex, Course, Dose } from "@/types/dose";

const BASE = "/content";

/**
 * A dose realmente não existe mais (404 / sumiu do course.json) — coisa
 * diferente de "não deu para buscar agora" (offline, servidor fora do ar).
 * A distinção importa: quem limpa registro órfão do SRS só pode agir sobre a
 * primeira, senão um voo de avião apagaria o progresso do aluno.
 */
export class DoseMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DoseMissingError";
  }
}

/**
 * `missingIsDose`: um 404 aqui significa "a dose sumiu". Só vale para o próprio
 * `dose.json`. Um 404 de `index.json`/`course.json` é a pasta `content/` inteira
 * fora do ar (disco desmontado, deploy pela metade) — tratar isso como "dose
 * sumiu" fazia a revisão apagar TODOS os cards vencidos, com tombstone, e a
 * perda viajava pela sincronização.
 */
async function getJSON<T>(url: string, missingIsDose = false, fresh = false): Promise<T> {
  // `reload` = a fonte, não a cópia: o service worker devolve `content/*.json`
  // do cache (stale-while-revalidate) e `no-cache` não passa por ele. Quem vai
  // apagar registro por "dose sumiu" precisa da resposta real do servidor.
  const res = await fetch(url, { cache: fresh ? "reload" : "no-cache" });
  if (!res.ok) {
    const msg = `${res.status} ${res.statusText} — ${url}`;
    throw res.status === 404 && missingIsDose ? new DoseMissingError(msg) : new Error(msg);
  }
  return (await res.json()) as T;
}

let _indexCache: ContentIndex | null = null;

export async function loadIndex(force = false): Promise<ContentIndex> {
  if (_indexCache && !force) return _indexCache;
  _indexCache = await getJSON<ContentIndex>(`${BASE}/index.json`);
  return _indexCache;
}

const _courseCache = new Map<string, Course>();

export async function loadCourse(coursePath: string, fresh = false): Promise<Course> {
  const hit = _courseCache.get(coursePath);
  if (hit && !fresh) return hit;
  const course = await getJSON<Course>(`${BASE}/${coursePath}`, false, fresh);
  _courseCache.set(coursePath, course);
  return course;
}

const _doseCache = new Map<string, Dose>();

/** dosePath is relative to the language folder, e.g. "course/A2-01/dose.json". */
export async function loadDose(lang: string, dosePath: string, fresh = false): Promise<Dose> {
  const url = `${BASE}/${lang}/${dosePath}`;
  const hit = _doseCache.get(url);
  if (hit && !fresh) return hit;
  const dose = await getJSON<Dose>(url, true, fresh);
  _doseCache.set(url, dose);
  return dose;
}

/** Absolute URL for a media path stored relative to a dose's folder. */
export function mediaUrl(lang: string, dosePath: string, rel: string): string {
  // dosePath = "course/A2-01/dose.json" -> dir "course/A2-01"
  const dir = dosePath.split("/").slice(0, -1).join("/");
  return `${BASE}/${lang}/${dir}/${rel}`;
}

/** Convenience: resolve the main media URL for a dose given its ref path. */
export function doseMediaUrl(dose: Dose, dosePath: string): string {
  return mediaUrl(dose.language, dosePath, dose.media.src);
}

/** Load a language's course via the top-level index. */
export async function loadCourseByLanguage(lang: string, fresh = false): Promise<Course> {
  const index = await loadIndex(fresh);
  const entry = index.languages.find((l) => l.code === lang);
  if (!entry) throw new Error(`Idioma não encontrado: ${lang}`);
  return loadCourse(entry.coursePath, fresh);
}

export interface ResolvedDose {
  dose: Dose;
  path: string; // relative to lang folder
  mediaUrl: string;
}

/**
 * Resolve a dose (+ its media URL) from its global id, using the course index.
 *
 * `fresh` ignora as cópias (memória e service worker) e vai ao servidor. Só com
 * ele um `DoseMissingError` significa que a dose sumiu de verdade: o
 * `course.json` em cache pode simplesmente ser de antes de a dose existir.
 */
export async function resolveDose(lang: string, doseId: string, fresh = false): Promise<ResolvedDose> {
  const course = await loadCourseByLanguage(lang, fresh);
  const ref = course.doses.find((d) => d.id === doseId);
  if (!ref) throw new DoseMissingError(`Dose não encontrada: ${doseId}`);
  const dose = await loadDose(lang, ref.path, fresh);
  return { dose, path: ref.path, mediaUrl: mediaUrl(lang, ref.path, dose.media.src) };
}
