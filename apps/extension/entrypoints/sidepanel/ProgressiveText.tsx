interface ProgressiveTextProps {
  text: string;
  className?: string;
}

export function ProgressiveText({ text, className }: ProgressiveTextProps) {
  return <span className={`progressive-text${className ? ` ${className}` : ""}`}>{text}</span>;
}
