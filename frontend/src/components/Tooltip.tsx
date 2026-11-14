import React, { useState } from "react";
import { HelpCircle } from "lucide-react";

interface TooltipProps {
  content: string;
  children: React.ReactNode;
  position?: "top" | "bottom";
  align?: "center" | "left" | "right";
}

export const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  position = "bottom",
  align = "center",
}) => {
  const [visible, setVisible] = useState(false);

  const posClasses =
    position === "top" ? "bottom-full mb-2" : "top-full mt-2";

  const alignClasses =
    align === "left"
      ? "left-0"
      : align === "right"
      ? "right-0"
      : "left-1/2 -translate-x-1/2";

  return (
    <div
      className="relative inline-flex items-center"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
    >
      {children}
      {visible && (
        <div
          role="tooltip"
          className={`pointer-events-none absolute z-50 w-64 rounded-lg bg-slate-950/95 border border-slate-700 px-3 py-2 text-[11px] font-normal leading-relaxed text-slate-200 shadow-2xl backdrop-blur-md ${posClasses} ${alignClasses}`}
        >
          {content}
        </div>
      )}
    </div>
  );
};

interface InfoTooltipProps {
  content: string;
  position?: "top" | "bottom";
  align?: "center" | "left" | "right";
}

export const InfoTooltip: React.FC<InfoTooltipProps> = ({
  content,
  position = "bottom",
  align = "center",
}) => {
  return (
    <Tooltip content={content} position={position} align={align}>
      <button
        type="button"
        aria-label="More information"
        className="inline-flex items-center justify-center text-slate-500 hover:text-slate-300 focus:outline-none transition-colors"
      >
        <HelpCircle className="w-3.5 h-3.5" />
      </button>
    </Tooltip>
  );
};
