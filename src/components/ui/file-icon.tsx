import { Archive, File, FileAudio, FileImage, FileText, FileVideo } from "lucide-react";
import { cn } from "@/lib/cn";

export type FileCategory = "image" | "video" | "audio" | "document" | "archive" | "other";

const icons = {
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  document: FileText,
  archive: Archive,
  other: File,
} satisfies Record<FileCategory, typeof File>;

const colors: Record<FileCategory, string> = {
  image: "bg-violet-400/10 text-violet-300",
  video: "bg-sky-400/10 text-sky-300",
  audio: "bg-amber-400/10 text-amber-300",
  document: "bg-teal-400/10 text-teal-300",
  archive: "bg-orange-400/10 text-orange-300",
  other: "bg-slate-400/10 text-slate-300",
};

type FileIconProps = {
  category: FileCategory;
  className?: string;
  decorative?: boolean;
};

export function FileIcon({ category, className, decorative = true }: FileIconProps) {
  const Icon = icons[category];
  return (
    <span
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : `${category} file`}
      role={decorative ? undefined : "img"}
      className={cn("inline-flex size-12 shrink-0 items-center justify-center rounded-xl", colors[category], className)}
    >
      <Icon aria-hidden="true" size={22} strokeWidth={1.8} />
    </span>
  );
}
