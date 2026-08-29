import * as React from 'react';

import { cn } from '@/lib/utils';

const MIN_COLUMN_WIDTH = 80;
const COLUMN_RESIZE_STEP = 16;

type ColumnResizeSession = {
  cell: HTMLTableCellElement;
  table: HTMLTableElement;
  pointerId: number;
  startX: number;
  startWidth: number;
  minimumWidth: number;
  startTableWidth: number;
};

/** Captures the current column and table measurements needed to start a safe resize. */
function prepareColumnResize(cell: HTMLTableCellElement) {
  const table = cell.closest('table');
  const row = cell.parentElement;

  if (!table || !(row instanceof HTMLTableRowElement)) {
    return null;
  }

  const cells = Array.from(row.cells);
  const widths = cells.map((headerCell) => headerCell.getBoundingClientRect().width);
  const cssMinimumWidth = Number.parseFloat(window.getComputedStyle(cell).minWidth);
  const minimumWidth = Number.isFinite(cssMinimumWidth)
    ? Math.max(MIN_COLUMN_WIDTH, cssMinimumWidth)
    : MIN_COLUMN_WIDTH;

  cells.forEach((headerCell, index) => {
    headerCell.style.width = `${widths[index]}px`;
  });

  return {
    table,
    startWidth: widths[cell.cellIndex] ?? cell.getBoundingClientRect().width,
    minimumWidth,
    startTableWidth: table.getBoundingClientRect().width
  };
}

/** Applies a requested column width while keeping the overall table aligned. */
function setColumnWidth(
  session: Pick<
    ColumnResizeSession,
    'cell' | 'table' | 'startWidth' | 'startTableWidth' | 'minimumWidth'
  >,
  requestedWidth: number
) {
  const width = Math.max(session.minimumWidth, Math.round(requestedWidth));
  const tableWidth = Math.round(session.startTableWidth + width - session.startWidth);

  session.cell.style.width = `${width}px`;
  session.table.style.width = `${tableWidth}px`;
}

/** Derives an accessible name for a column's resize control. */
function getResizeHandleLabel(
  children: React.ReactNode,
  headerLabel: React.AriaAttributes['aria-label']
) {
  const columnName =
    typeof children === 'string' || typeof children === 'number'
      ? String(children).trim()
      : headerLabel;

  return columnName ? `Resize ${columnName} column` : 'Resize column';
}

/** Presents tabular information in a horizontally scrollable surface when space is limited. */
function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return (
    <div data-slot="table-container" className="relative min-w-0 w-full overflow-x-auto">
      <table
        data-slot="table"
        className={cn('w-full table-fixed caption-bottom text-sm', className)}
        {...props}
      />
    </div>
  );
}

/** Groups the headings that describe a table's columns. */
function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead data-slot="table-header" className={cn('[&_tr]:border-b', className)} {...props} />;
}

/** Groups the primary data rows within a table. */
function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return (
    <tbody
      data-slot="table-body"
      className={cn('[&_tr:last-child]:border-0', className)}
      {...props}
    />
  );
}

/** Groups summary rows at the end of a table. */
function TableFooter({ className, ...props }: React.ComponentProps<'tfoot'>) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn('border-t bg-muted/50 font-medium [&>tr]:last:border-b-0', className)}
      {...props}
    />
  );
}

/** Presents one table row with consistent selection and hover treatment. */
function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        'border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted',
        className
      )}
      {...props}
    />
  );
}

/** Presents a column heading and optionally lets users resize that column accessibly. */
function TableHead({ className, children, ...props }: React.ComponentProps<'th'>) {
  const resizeSession = React.useRef<ColumnResizeSession | null>(null);
  const resizeHandleLabel = getResizeHandleLabel(children, props['aria-label']);

  function handlePointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    const cell = event.currentTarget.parentElement;

    if (!(cell instanceof HTMLTableCellElement)) {
      return;
    }

    const prepared = prepareColumnResize(cell);

    if (!prepared) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeSession.current = {
      ...prepared,
      cell,
      pointerId: event.pointerId,
      startX: event.clientX
    };
  }

  function handlePointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const session = resizeSession.current;

    if (!session || session.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    setColumnWidth(session, session.startWidth + event.clientX - session.startX);
  }

  function handlePointerEnd(event: React.PointerEvent<HTMLButtonElement>) {
    const session = resizeSession.current;

    if (!session || session.pointerId !== event.pointerId) {
      return;
    }

    setColumnWidth(session, session.startWidth + event.clientX - session.startX);
    resizeSession.current = null;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handlePointerCancel(event: React.PointerEvent<HTMLButtonElement>) {
    const session = resizeSession.current;

    if (!session || session.pointerId !== event.pointerId) {
      return;
    }

    resizeSession.current = null;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }

    const cell = event.currentTarget.parentElement;

    if (!(cell instanceof HTMLTableCellElement)) {
      return;
    }

    const prepared = prepareColumnResize(cell);

    if (!prepared) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setColumnWidth(
      { ...prepared, cell },
      prepared.startWidth + (event.key === 'ArrowRight' ? COLUMN_RESIZE_STEP : -COLUMN_RESIZE_STEP)
    );
  }

  return (
    <th
      data-slot="table-head"
      className={cn(
        'relative h-10 overflow-hidden text-ellipsis whitespace-nowrap px-2 pr-5 text-left align-middle font-medium text-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]',
        className
      )}
      {...props}
    >
      {children}
      <button
        type="button"
        data-slot="table-column-resize-handle"
        aria-label={resizeHandleLabel}
        title={resizeHandleLabel}
        className="absolute inset-y-1 right-0 z-10 w-3 touch-none cursor-col-resize select-none rounded-sm bg-transparent p-0 outline-none after:absolute after:inset-y-1 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-border hover:after:bg-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
        onPointerCancel={handlePointerCancel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onLostPointerCapture={() => {
          resizeSession.current = null;
        }}
      />
    </th>
  );
}

/** Presents one data value within a table row. */
function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        'overflow-hidden text-ellipsis whitespace-nowrap p-2 align-middle [&>*]:overflow-hidden [&>*]:text-ellipsis [&>*]:whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]',
        className
      )}
      {...props}
    />
  );
}

/** Provides a descriptive caption for the table. */
function TableCaption({ className, ...props }: React.ComponentProps<'caption'>) {
  return (
    <caption
      data-slot="table-caption"
      className={cn('mt-4 text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

export { Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow };
