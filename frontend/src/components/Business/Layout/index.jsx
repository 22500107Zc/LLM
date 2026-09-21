import React from "react";
import { FullScreenLoader } from "@/components/Preloader";

/**
 * Shared chrome for every business page: a consistent heading, an optional
 * action area, and uniform loading / error / empty states so the product reads
 * as one system rather than a collection of screens.
 */
export default function BusinessPage({
  title,
  description = null,
  actions = null,
  loading = false,
  error = null,
  children,
}) {
  return (
    <div className="flex flex-col w-full h-full overflow-y-auto">
      {/*
        On a phone the application renders a fixed 64px header bar, so the
        page heading needs to clear it. Extra top padding below `md` only.
      */}
      <div className="flex flex-col w-full max-w-[1400px] mx-auto px-4 md:px-6 pt-20 md:pt-8 pb-8 gap-y-6">
        {/*
          The application shell floats the account avatar in the top-right
          corner, so a page's action buttons need room to clear it.
        */}
        <header className="flex flex-wrap items-start justify-between gap-4 pr-14">
          <div className="flex flex-col gap-y-1">
            <h1 className="text-2xl font-semibold text-theme-text-primary">
              {title}
            </h1>
            {description && (
              <p className="text-sm text-theme-text-secondary max-w-2xl">
                {description}
              </p>
            )}
          </div>
          {actions && (
            <div className="flex items-center gap-x-2">{actions}</div>
          )}
        </header>

        {error && <ErrorBanner message={error} />}

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <FullScreenLoader />
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

export function ErrorBanner({ message }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300"
    >
      {message}
    </div>
  );
}

export function Card({
  title = null,
  actions = null,
  children,
  className = "",
}) {
  return (
    <section
      className={`rounded-xl border border-theme-modal-border bg-theme-bg-secondary p-5 ${className}`}
    >
      {(title || actions) && (
        <div className="flex items-center justify-between mb-4">
          {title && (
            <h2 className="text-sm font-semibold uppercase tracking-wide text-theme-text-secondary">
              {title}
            </h2>
          )}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint = null, estimate = false }) {
  return (
    <div className="rounded-xl border border-theme-modal-border bg-theme-bg-secondary p-4">
      <p className="text-xs uppercase tracking-wide text-theme-text-secondary">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold text-theme-text-primary">
        {value}
      </p>
      {(hint || estimate) && (
        <p className="mt-1 text-xs text-theme-text-secondary">
          {/* Estimated figures are always labelled - a business must never
              mistake a proxy metric for a measurement. */}
          {estimate ? "Estimated" : ""}
          {estimate && hint ? " · " : ""}
          {hint}
        </p>
      )}
    </div>
  );
}

export function EmptyState({ title, description = null, action = null }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-theme-modal-border py-16 px-6 text-center">
      <p className="text-base font-medium text-theme-text-primary">{title}</p>
      {description && (
        <p className="mt-2 max-w-md text-sm text-theme-text-secondary">
          {description}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = "primary",
  disabled = false,
  type = "button",
  className = "",
}) {
  const styles = {
    primary:
      "bg-theme-button-primary hover:bg-theme-button-primary-hover text-white border-transparent",
    secondary:
      "bg-transparent hover:bg-theme-sidebar-item-hover text-theme-text-primary border-theme-modal-border",
    danger: "bg-transparent hover:bg-red-500/10 text-red-400 border-red-500/40",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg border px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        styles[variant] ?? styles.primary
      } ${className}`}
    >
      {children}
    </button>
  );
}

export function Badge({ children, tone = "neutral" }) {
  const tones = {
    neutral:
      "bg-theme-bg-primary text-theme-text-secondary border-theme-modal-border",
    success: "bg-green-500/10 text-green-400 border-green-500/30",
    warning: "bg-amber-500/10 text-amber-400 border-amber-500/30",
    danger: "bg-red-500/10 text-red-400 border-red-500/30",
    info: "bg-blue-500/10 text-blue-400 border-blue-500/30",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${
        tones[tone] ?? tones.neutral
      }`}
    >
      {children}
    </span>
  );
}

export function Table({ columns, rows, empty = "Nothing to show yet." }) {
  if (!rows?.length)
    return (
      <p className="py-10 text-center text-sm text-theme-text-secondary">
        {empty}
      </p>
    );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-theme-modal-border">
            {columns.map((column) => (
              <th
                key={column.key}
                className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-theme-text-secondary"
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={row.id ?? row.uuid ?? index}
              className="border-b border-theme-modal-border/50 last:border-0 hover:bg-theme-sidebar-item-hover/40"
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className="px-3 py-3 align-top text-theme-text-primary"
                >
                  {column.render
                    ? column.render(row)
                    : (row[column.key] ?? "—")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
