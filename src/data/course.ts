import courseContent from '../content/course/page.json';

export type LessonStatus = 'completed' | 'current' | 'locked';

export interface LessonMaterial {
  label: string;
  kind: string;
  href?: string;
  file?: string;
}

export interface Lesson {
  id: string;
  order: number;
  title: string;
  subtitle: string;
  videoThumbnail: string;
  videoUrl?: string;
  videoFile?: string;
  duration: string;
  estimatedTime: string;
  preview: string;
  objectives: string[];
  tips: string[];
  summary: string;
  encouragement: string;
  materials: LessonMaterial[];
  status: LessonStatus;
  requiresQuiz?: boolean;
}

export interface QuizQuestion {
  id: string;
  question: string;
  options: string[];
  correctIndex: number;
}

export interface Quiz {
  title: string;
  intro: string;
  afterLessonOrder: number;
  passThreshold: number;
  questions: QuizQuestion[];
}

export interface CourseStat {
  label: string;
  value: string;
}

export interface CourseHeroImage {
  src: string;
  alt: string;
}

export interface CourseMapLabels {
  intro: string;
  god: string;
  bible: string;
  inspire: string;
  prayer: string;
  community: string;
  life: string;
  mission: string;
  world: string;
}

export interface CourseMapIntro {
  titleAccent: string;
  subtitle: string;
  hint: string;
}

export interface Course {
  eyebrow: string;
  title: string;
  description: string;
  stats: CourseStat[];
  heroImages: CourseHeroImage[];
  mapIntro?: CourseMapIntro;
  mapLabels?: CourseMapLabels;
  lessons: Lesson[];
  quiz: Quiz;
}

export const course = courseContent as Course;
