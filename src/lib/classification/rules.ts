/**
 * Deterministic, rule-based classification (version `rules-v1`).
 *
 *  - Category: mapped from the source `Topic` via ticket_categories.source_topics.
 *  - Subcategory ("issue theme"): detected from the student's free-text details
 *    with bilingual (Arabic/English) keyword rules.
 *
 * This is an indicative analytical lens, NOT a verified root cause. It runs
 * locally inside the importer; no text is ever sent to an external service.
 */

export const CLASSIFICATION_VERSION = "rules-v1";

export type SubcategoryCode =
  | "attendance_records"
  | "grades_evaluation"
  | "platform_access"
  | "session_joining"
  | "projects_assignments"
  | "quizzes_exams"
  | "certificates"
  | "connectivity_media"
  | "tutor_availability"
  | "schedule_group"
  | "community_channels"
  | "explanation_quality"
  | "venue_logistics"
  | "no_free_text"
  | "unmatched";

interface ThemeRule {
  code: Exclude<SubcategoryCode, "no_free_text" | "unmatched">;
  /** Each term: a label (stored as evidence) and a regex applied to normalized text. */
  terms: { label: string; re: RegExp }[];
}

/** Arabic letter class used to emulate word boundaries (JS \b is ASCII-only). */
const AR = "\\u0621-\\u064A";

function ar(label: string, stem: string, opts: { exact?: boolean; notBefore?: string } = {}): { label: string; re: RegExp } {
  const tail = opts.exact ? `(?![${AR}])` : "";
  const neg = opts.notBefore ? `(?!${opts.notBefore})` : "";
  return { label, re: new RegExp(`${stem}${neg}${tail}`, "u") };
}

function en(label: string, pattern: string): { label: string; re: RegExp } {
  return { label, re: new RegExp(`\\b${pattern}`, "iu") };
}

/** Order matters only to break ties (earlier wins). */
export const THEME_RULES: ThemeRule[] = [
  {
    code: "attendance_records",
    terms: [
      ar("غياب", "غياب"),
      ar("غايب", "غايب"),
      ar("حضور", "حضور"),
      ar("حضر", "حضر(ت|نا|وا)?", { exact: true }),
      ar("كنت حاضر", "كنت حاضر"),
      ar("رفع الغياب", "رفع (ال)?غياب"),
      en("absent", "absen"),
      en("attendance", "attend"),
    ],
  },
  {
    code: "grades_evaluation",
    terms: [
      ar("درجه", "درج(ه|ات)"),
      ar("تقييم", "تق(ي)?يم"),
      ar("تعليق", "تعليق"),
      en("grade", "grade"),
      en("score", "score"),
      en("evaluation", "evaluat"),
      en("feedback", "feedback"),
      en("marks", "marks"),
    ],
  },
  {
    code: "platform_access",
    terms: [
      ar("تسجيل الدخول", "تسجيل (ال)?دخول"),
      ar("لوجين", "لوجين"),
      ar("باسورد", "باس(و)?ورد"),
      ar("كلمه السر", "كلمه (السر|المرور)"),
      ar("الحساب", "(ال)?حساب", { exact: true }),
      ar("اكونت", "اكونت"),
      ar("المنصه", "(ال)?منصه", { exact: true }),
      ar("التطبيق", "(ال)?تطبيق", { exact: true }),
      ar("الابلكيشن", "(ال)?اب(ل)?(ي)?كيشن"),
      ar("مش بيفتح", "(مش|مبي|لا) ?(بي|ي)?فتح"),
      ar("عطل", "عطل"),
      ar("ايرور", "ايرور"),
      en("login", "log ?in"),
      en("password", "password"),
      en("account", "account"),
      en("platform", "platform"),
      en("error", "error"),
      en("not opening", "(not|won'?t|can'?t|cannot) open"),
    ],
  },
  {
    code: "session_joining",
    terms: [
      ar("لينك", "لينك"),
      ar("رابط", "(ال)?رابط"),
      ar("انضمام", "(ال)?انضمام"),
      ar("زوم", "زوم"),
      en("link", "link"),
      en("join", "join"),
      en("zoom", "zoom"),
      en("meet", "meet\\b"),
    ],
  },
  {
    code: "projects_assignments",
    terms: [
      ar("مشروع", "(ال)?مشروع"),
      ar("بروجكت", "بروج(ي)?كت"),
      ar("تاسك", "تاسك"),
      ar("واجب", "(ال)?واجب"),
      ar("تسليم", "(ال)?تسليم"),
      ar("اسايمنت", "اسا(ي)?منت"),
      en("project", "project"),
      en("task", "task"),
      en("assignment", "assignment"),
      en("submission", "submi(t|ssion)"),
    ],
  },
  {
    code: "quizzes_exams",
    terms: [
      ar("امتحان", "(ال)?امتحان"),
      ar("كويز", "كويز"),
      ar("اختبار", "(ال)?اختب(ا)?ر"),
      en("quiz", "quiz"),
      en("exam", "exam"),
    ],
  },
  {
    code: "certificates",
    terms: [ar("شهاده", "شهاد(ه|ات)"), en("certificate", "certificat")],
  },
  {
    code: "connectivity_media",
    terms: [
      ar("انترنت", "(ال)?انترنت"),
      ar("النت", "النت", { exact: true }),
      ar("الشبكه", "الشبكه", { exact: true }),
      ar("صوت", "(ال)?صوت"),
      ar("مايك", "(ال)?ما?يك", { exact: true }),
      ar("كاميرا", "(ال)?كاميرا"),
      ar("فيديو", "(ال)?فيديو"),
      ar("بيقطع", "(بيقطع|تقطيع)"),
      en("internet", "internet"),
      en("connection", "connection"),
      en("audio", "(audio|sound)"),
      en("microphone", "mic(rophone)?\\b"),
      en("camera", "camera"),
      en("video", "video"),
    ],
  },
  {
    code: "tutor_availability",
    terms: [
      ar("مفيش مدرس", "(مفيش|مافيش|لا يوجد) (مدرس|مس|مستر|مدرب|المدرس|المدرب)"),
      ar("المدرس مش موجود", "(المدرس|المدرسه|المدرب|المس|المستر) (مش|مكانش|لم يكن) (موجود|موجوده|حاضر)"),
      ar("مجاش", "(مجاش|مجتش|محضرش|محضرتش|ما حضرش)"),
      ar("متاخر", "(متاخر|اتاخر|تاخير|تاخر)"),
      ar("مشي بدري", "(مشي|مشيت|خلص|خلصت|مشانا|مشينا) بدري"),
      en("late", "late\\b"),
      en("no tutor", "no (tutor|teacher|instructor)"),
      en("did not show", "(didn'?t|did not) (show|come|attend)"),
    ],
  },
  {
    code: "schedule_group",
    terms: [
      ar("ميعاد", "(ال)?(ميعاد|مواعيد|موعد)"),
      ar("تغيير الجروب", "(تغيير|تحويل|نقل) (ال)?(جروب|مجموعه)"),
      ar("الجدول", "(ال)?جدول"),
      en("schedule", "schedul"),
      en("time slot", "(time slot|timing|reschedul)"),
    ],
  },
  {
    code: "community_channels",
    terms: [
      ar("كوميونتي", "(ال)?كوم(ي)?(و)?ن(ي)?تي"),
      ar("واتساب", "(ال)?واتس"),
      ar("تليجرام", "(ال)?تل(ي)?جرام"),
      ar("الجروب", "(ال)?جروب", { exact: true }),
      ar("محدش بيرد", "(محدش|مفيش حد|حد) (بيرد|يرد|رد)"),
      ar("مش بيرد", "(مش بيرد|مبيردش|مبيردوش|مش بيردو|بدون رد)"),
      en("community", "community"),
      en("whatsapp", "whats ?app"),
      en("telegram", "telegram"),
      en("no reply", "(no (reply|response)|not respond)"),
    ],
  },
  {
    code: "explanation_quality",
    terms: [
      ar("الشرح", "(ال)?شرح", { exact: true }),
      ar("بيشرح", "(بيشرح|مبيشرحش|يشرح)"),
      ar("مش فاهم", "(مش فاهم|مش فاهمين|مفهمتش|مفهمناش|مش بنفهم)"),
      ar("المحتوي", "(ال)?محتوي"),
      en("explanation", "explain"),
      en("understand", "understand"),
      en("content", "content"),
    ],
  },
  {
    code: "venue_logistics",
    terms: [
      ar("المكان", "(ال)?مكان", { exact: true }),
      ar("لاب", "(ال)?لاب(ات)?", { exact: true }),
      ar("الاجهزه", "(ال)?اجهز(ه)?"),
      ar("وجبه", "(ال)?وجب(ه|ات)", { exact: true }),
      ar("قاعه", "(ال)?قاع(ه|ات)", { exact: true }),
      ar("تكييف", "(ال)?تكييف"),
      ar("نظافه", "(ال)?نظاف(ه)?"),
      en("venue", "venue"),
      en("lab", "labs?\\b"),
      en("devices", "device"),
      en("meal", "meal"),
    ],
  },
];

const DIACRITICS = /[ً-ٰٟۖ-ۭ]/g;
const ARABIC_INDIC_DIGITS = /[٠-٩]/g;
const PERSIAN_DIGITS = /[۰-۹]/g;

/** Normalizes Arabic orthographic variants and casing so keyword rules are robust. */
export function normalizeForMatching(text: string): string {
  return text
    .normalize("NFKC")
    .replace(DIACRITICS, "")
    .replace(/ـ/g, "") // tatweel
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(ARABIC_INDIC_DIGITS, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(PERSIAN_DIGITS, (d) => String(d.charCodeAt(0) - 0x06f0))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export interface ThemeResult {
  subcategory: SubcategoryCode;
  /** Heuristic indicator in [0,1]; null when nothing matched. */
  confidence: number | null;
  matchedTerms: string[];
  scores: Partial<Record<SubcategoryCode, number>>;
}

export function detectTheme(details: string | null | undefined): ThemeResult {
  if (details == null || details.trim() === "") {
    return { subcategory: "no_free_text", confidence: 1, matchedTerms: [], scores: {} };
  }
  const text = normalizeForMatching(details);
  const scores: Partial<Record<SubcategoryCode, number>> = {};
  const matched: Record<string, string[]> = {};

  for (const rule of THEME_RULES) {
    for (const term of rule.terms) {
      if (term.re.test(text)) {
        scores[rule.code] = (scores[rule.code] ?? 0) + 1;
        (matched[rule.code] ??= []).push(term.label);
      }
    }
  }

  let best: SubcategoryCode | null = null;
  let bestScore = 0;
  let tie = false;
  for (const rule of THEME_RULES) {
    const s = scores[rule.code] ?? 0;
    if (s > bestScore) {
      best = rule.code;
      bestScore = s;
      tie = false;
    } else if (s > 0 && s === bestScore) {
      tie = true;
    }
  }

  if (!best) {
    return { subcategory: "unmatched", confidence: null, matchedTerms: [], scores };
  }

  const baseConfidence = bestScore >= 3 ? 0.85 : bestScore === 2 ? 0.7 : 0.55;
  const confidence = Math.round((tie ? baseConfidence - 0.15 : baseConfidence) * 1000) / 1000;
  return { subcategory: best, confidence, matchedTerms: matched[best] ?? [], scores };
}

export interface CategoryMapping {
  code: string;
  sourceTopics: string[];
}

export function categoryForTopic(topic: string, mappings: CategoryMapping[]): string {
  const t = topic.trim();
  return mappings.find((m) => m.sourceTopics.includes(t))?.code ?? "uncategorized";
}

export interface ClassificationResult {
  categoryCode: string;
  subcategoryCode: SubcategoryCode;
  confidence: number | null;
  evidence: {
    topic_mapped: boolean;
    matched_terms: string[];
    theme_scores: Partial<Record<SubcategoryCode, number>>;
  };
}

export function classifyTicket(
  topic: string,
  details: string | null,
  mappings: CategoryMapping[],
): ClassificationResult {
  const categoryCode = categoryForTopic(topic, mappings);
  const theme = detectTheme(details);
  return {
    categoryCode,
    subcategoryCode: theme.subcategory,
    confidence: theme.confidence,
    evidence: {
      topic_mapped: categoryCode !== "uncategorized",
      matched_terms: theme.matchedTerms,
      theme_scores: theme.scores,
    },
  };
}
