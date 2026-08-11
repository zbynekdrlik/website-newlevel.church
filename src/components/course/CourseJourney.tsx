"use client"

import type React from "react"
import { useEffect, useMemo, useState } from "react"
import {
  BookOpen,
  Check,
  ClipboardCheck,
  FileText,
  Globe2,
  Heart,
  Lock,
  MessageCircle,
  Play,
  Sparkles,
  Users,
} from "lucide-react"
import { course } from "../../data/course"
import { cn } from "../../utils/cn"

const lessonLayouts = [
  {
    cardClass: "course-board__card--one",
    nodeClass: "course-board__node--one",
    accent: "red",
    marker: "sun",
  },
  {
    cardClass: "course-board__card--two",
    nodeClass: "course-board__node--two",
    accent: "teal",
    marker: "book",
  },
  {
    cardClass: "course-board__card--three",
    nodeClass: "course-board__node--three",
    accent: "teal",
    marker: "message",
  },
  {
    cardClass: "course-board__card--four",
    nodeClass: "course-board__node--four",
    accent: "dark",
    marker: "users",
  },
  {
    cardClass: "course-board__card--five",
    nodeClass: "course-board__node--five",
    accent: "dark",
    marker: "heart",
  },
  {
    cardClass: "course-board__card--six",
    nodeClass: "course-board__node--six",
    accent: "dark",
    marker: "globe",
  },
] as const

const COURSE_PROGRESS_KEY = "newlevel-course-progress-v1"

type CourseProgress = {
  videos?: Record<string, boolean>
  quizzes?: Record<string, boolean>
}

type LessonViewState = "done" | "current" | "locked"

const defaultMapLabels = {
  intro: "Úvod do kurzu",
  god: "Kto je Boh?",
  bible: "Biblia ako Boží list",
  inspire: "Inšpirácia Písma",
  prayer: "Modlitba a komunikácia",
  community: "Vzťahy a spoločenstvo",
  life: "Život v spoločenstve",
  mission: "Poslanie a služba",
  world: "Vplývame na svet",
}

const defaultMapIntro = {
  titleAccent: "pre mladých",
  subtitle: "Objavuj pravdu, buduj vzťah s Bohom a ži život, ktorý má zmysel.",
  reference: "",
  hint: "Klikni na bod cesty a otvor lekciu",
}

function readCourseProgress(): CourseProgress {
  if (typeof window === "undefined") return {}

  try {
    const rawProgress = window.localStorage.getItem(COURSE_PROGRESS_KEY)
    return rawProgress ? JSON.parse(rawProgress) : {}
  } catch {
    return {}
  }
}

function lessonNeedsQuiz(lesson: (typeof course.lessons)[number]) {
  return Boolean(lesson.quiz) || lesson.order === course.quiz.afterLessonOrder
}

function lessonHasVideo(lesson: (typeof course.lessons)[number]) {
  return Boolean(lesson.videoFile || lesson.videoUrl)
}

function isLessonDone(lesson: (typeof course.lessons)[number], progress: CourseProgress) {
  const videoDone = lessonHasVideo(lesson) ? Boolean(progress.videos?.[lesson.id]) : true
  const quizDone = lessonNeedsQuiz(lesson) ? Boolean(progress.quizzes?.[lesson.id]) : true

  return videoDone && quizDone
}

export function CourseJourney() {
  const { lessons } = course
  const [progress, setProgress] = useState<CourseProgress>({})
  const [progressLoaded, setProgressLoaded] = useState(false)
  const intro = { ...defaultMapIntro, ...course.mapIntro }
  const labels = { ...defaultMapLabels, ...course.mapLabels }
  const mapLabels = [
    { className: "course-board__label--intro", title: labels.intro, icon: Sparkles },
    { className: "course-board__label--god", title: labels.god, icon: Sparkles },
    { className: "course-board__label--bible", title: labels.bible, icon: BookOpen },
    { className: "course-board__label--inspire", title: labels.inspire, icon: Sparkles },
    { className: "course-board__label--prayer", title: labels.prayer, icon: MessageCircle },
    { className: "course-board__label--community", title: labels.community, icon: Users },
    { className: "course-board__label--life", title: labels.life, icon: Users },
    { className: "course-board__label--mission", title: labels.mission, icon: Heart },
    { className: "course-board__label--world", title: labels.world, icon: Globe2 },
  ]
  const lessonStates = useMemo(() => {
    return lessons.map((lesson, index) => {
      const previousLessons = lessons.slice(0, index)
      const locked = previousLessons.some((previousLesson) => !isLessonDone(previousLesson, progress))
      const done = !locked && isLessonDone(lesson, progress)
      const state: LessonViewState = locked ? "locked" : done ? "done" : "current"

      return {
        done,
        locked,
        state,
      }
    })
  }, [lessons, progress])
  const completedLessons = lessonStates.filter((state) => state.done).length
  const currentLessonIndex = lessonStates.findIndex((state) => state.state === "current")
  const currentLesson = currentLessonIndex >= 0 ? lessons[currentLessonIndex] : lessons[lessons.length - 1]
  const progressPercent = Math.round((completedLessons / lessons.length) * 100)

  useEffect(() => {
    const syncProgress = () => {
      setProgress(readCourseProgress())
      setProgressLoaded(true)
    }

    syncProgress()
    window.addEventListener("storage", syncProgress)
    window.addEventListener("pageshow", syncProgress)
    window.addEventListener("newlevel-course-progress", syncProgress)

    return () => {
      window.removeEventListener("storage", syncProgress)
      window.removeEventListener("pageshow", syncProgress)
      window.removeEventListener("newlevel-course-progress", syncProgress)
    }
  }, [])

  return (
    <div
      className={cn("course-board", `course-board--done-${completedLessons}`)}
      data-progress-loaded={progressLoaded ? "true" : "false"}
    >
      <div className="course-board__intro">
        <h1>
          {course.title}
          {intro.titleAccent && <span>{intro.titleAccent}</span>}
        </h1>
        <blockquote className="course-board__scripture">
          <p>{intro.subtitle}</p>
          {intro.reference && <cite>{intro.reference}</cite>}
        </blockquote>
      </div>

      <div className="course-board__progress-panel" aria-live="polite">
        <span>Progres kurzu</span>
        <strong>{completedLessons}/{lessons.length}</strong>
        <div className="course-board__progress-bar" aria-hidden="true">
          <i style={{ width: `${progressPercent}%` }}></i>
        </div>
        <p>
          {completedLessons === lessons.length
            ? "Celá cesta je dokončená."
            : `Ďalší krok: ${String(currentLesson.order).padStart(2, "0")} ${currentLesson.title}`}
        </p>
      </div>

      <div className="course-board__track" aria-hidden="true">
        <svg viewBox="0 0 1600 760" preserveAspectRatio="xMidYMid meet">
          <defs>
            <filter id="course-road-shadow" x="-20%" y="-30%" width="140%" height="170%">
              <feDropShadow dx="0" dy="22" stdDeviation="18" floodColor="#000000" floodOpacity="0.55" />
            </filter>
            <linearGradient id="course-teal" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#189ea5" />
              <stop offset="55%" stopColor="#10727a" />
              <stop offset="100%" stopColor="#0a4f56" />
            </linearGradient>
            <linearGradient id="course-red" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#8f1118" />
              <stop offset="100%" stopColor="#e30d18" />
            </linearGradient>
            <linearGradient id="course-locked" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#15191d" />
              <stop offset="100%" stopColor="#33383d" />
            </linearGradient>
          </defs>

          <path
            className="course-board__road-shadow"
            d="M48 438 C190 500 260 446 335 350 C458 198 620 304 725 284 C865 260 886 92 1098 132 C1295 170 1375 322 1327 454 C1273 604 1035 622 920 530 C812 444 716 546 610 656 C498 772 316 682 170 666 C92 658 56 694 36 724"
          />
          <path
            className="course-board__road-base"
            d="M48 438 C190 500 260 446 335 350 C458 198 620 304 725 284 C865 260 886 92 1098 132 C1295 170 1375 322 1327 454 C1273 604 1035 622 920 530 C812 444 716 546 610 656 C498 772 316 682 170 666 C92 658 56 694 36 724"
          />
          <path
            className="course-board__road-border"
            d="M48 438 C190 500 260 446 335 350 C458 198 620 304 725 284 C865 260 886 92 1098 132 C1295 170 1375 322 1327 454 C1273 604 1035 622 920 530 C812 444 716 546 610 656 C498 772 316 682 170 666 C92 658 56 694 36 724"
          />
          <path
            className="course-board__road-inner"
            d="M48 438 C190 500 260 446 335 350 C458 198 620 304 725 284 C865 260 886 92 1098 132 C1295 170 1375 322 1327 454 C1273 604 1035 622 920 530 C812 444 716 546 610 656 C498 772 316 682 170 666 C92 658 56 694 36 724"
          />
          <path
            className="course-board__segment course-board__segment--red"
            d="M48 438 C190 500 260 446 335 350 C404 264 488 258 560 276"
          />
          <path
            className="course-board__segment course-board__segment--teal"
            d="M560 276 C625 294 674 294 725 284 C865 260 886 92 1098 132 C1295 170 1375 322 1327 454"
          />
          <path
            className="course-board__segment course-board__segment--locked"
            d="M1327 454 C1273 604 1035 622 920 530 C812 444 716 546 610 656 C498 772 316 682 170 666 C92 658 56 694 36 724"
          />
          <path
            className="course-board__road-line"
            d="M48 438 C190 500 260 446 335 350 C458 198 620 304 725 284 C865 260 886 92 1098 132 C1295 170 1375 322 1327 454 C1273 604 1035 622 920 530 C812 444 716 546 610 656 C498 772 316 682 170 666 C92 658 56 694 36 724"
          />
        </svg>

        {mapLabels.map((item) => {
          const Icon = item.icon
          return (
            <span key={item.className} className={cn("course-board__label", item.className)}>
              {item.title}
              <Icon aria-hidden="true" />
            </span>
          )
        })}
      </div>

      {lessons.map((lesson, index) => {
        const layout = lessonLayouts[index] ?? lessonLayouts[lessonLayouts.length - 1]
        const state = lessonStates[index]
        const locked = state.locked

        return (
          <a
            key={`${lesson.id}-node`}
            href={`/kurzy/${lesson.id}`}
            aria-disabled={locked}
            onClick={(event) => {
              if (locked) event.preventDefault()
            }}
            className={cn(
              "course-board__node",
              layout.nodeClass,
              state.done && "course-board__node--done",
              state.state === "current" && "course-board__node--current",
              locked && "course-board__node--locked",
            )}
            aria-label={`Otvoriť lekciu ${lesson.order}: ${lesson.title}`}
          >
            {state.done ? <Check aria-hidden="true" /> : <strong>{String(lesson.order).padStart(2, "0")}</strong>}
            {locked ? <Lock aria-hidden="true" /> : state.state === "current" ? <Play aria-hidden="true" /> : null}
            <span className="course-board__tooltip">
              {String(lesson.order).padStart(2, "0")} {lesson.title}
              <small>
                {state.done ? "Dokončené" : locked ? "Najprv dokonči predchádzajúcu lekciu" : "Pokračovať v lekcii"}
              </small>
            </span>
          </a>
        )
      })}

      <div className="course-board__hint">
        {intro.hint}
      </div>

      <div className="course-board__mobile-list">
        {lessons.map((lesson, index) => {
          const layout = lessonLayouts[index] ?? lessonLayouts[lessonLayouts.length - 1]
          const state = lessonStates[index]

          return (
            <LessonPopover
              key={lesson.id}
              lesson={lesson}
              layout={layout}
              hasQuiz={lessonNeedsQuiz(lesson)}
              state={state.state}
              locked={state.locked}
              mobile
            />
          )
        })}
      </div>

      <div className="course-board__legend">
        <span><i className="course-board__dot course-board__dot--done"></i>Dokončené</span>
        <span><i className="course-board__dot course-board__dot--current"></i>Aktuálne</span>
        <span><Lock aria-hidden="true" />Uzamknuté</span>
      </div>
    </div>
  )
}

function LessonPopover({
  lesson,
  layout,
  hasQuiz,
  state,
  locked,
  mobile = false,
}: {
  lesson: (typeof course.lessons)[number]
  layout: (typeof lessonLayouts)[number]
  hasQuiz: boolean
  state: LessonViewState
  locked: boolean
  mobile?: boolean
}) {
  const tone = state === "done" ? "teal" : state === "current" ? "red" : "dark"

  return (
    <div
      className={cn(
        "course-board__card",
        !mobile && layout.cardClass,
        state === "current" && "course-board__card--red",
        state === "done" && "course-board__card--teal",
        state === "locked" && "course-board__card--dark",
        mobile && "course-board__card--mobile",
      )}
      data-lesson-order={String(lesson.order).padStart(2, "0")}
      data-lesson-state={state}
    >
      <span className={cn("course-board__mini", `course-board__mini--${tone}`)}>
        {state === "done" ? <Check /> : locked ? <Lock /> : <Play />}
      </span>
      <small className={cn("course-board__state", `course-board__state--${tone}`)}>
        {state === "done" ? "Dokončené" : locked ? "Zamknuté" : "Aktuálne"}
      </small>
      <h2>
        {String(lesson.order).padStart(2, "0")} {lesson.title}
      </h2>
      <div className="course-board__actions">
        <Pill icon={<Play />} label="Video" tone={tone} disabled={locked} />
        {hasQuiz && (
          <Pill
            icon={<ClipboardCheck />}
            label="Test"
            tone={tone}
            disabled={locked}
          />
        )}
        <Pill icon={<FileText />} label="Materiály" tone={tone} disabled={locked} />
      </div>
      <a
        href={`/kurzy/${lesson.id}`}
        aria-disabled={locked}
        onClick={(event) => {
          if (locked) event.preventDefault()
        }}
        className={cn("course-board__detail", `course-board__detail--${tone}`)}
      >
        {locked ? "Zamknuté" : "Detail"}
      </a>
    </div>
  )
}

function Pill({
  icon,
  label,
  tone,
  disabled = false,
}: {
  icon: React.ReactNode
  label: string
  tone: "red" | "teal" | "dark"
  disabled?: boolean
}) {
  return (
    <span
      className={cn(
        "course-board__pill",
        `course-board__pill--${tone}`,
        disabled && "course-board__pill--disabled",
      )}
    >
      {icon}
      {label}
    </span>
  )
}
