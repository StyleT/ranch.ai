// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GateTable, delta } from './GateTable';
import type { ScoreResponse } from '@ranch/contracts';

describe('GateTable', () => {
  it('computes deltas with direction, lower-is-better for FPPF', () => {
    expect(delta(0.5, 0.6)).toEqual({ text: '+0.10', good: true }); expect(delta(0.27, 0.14, true)).toEqual({ text: '-0.13', good: true }); expect(delta(0.5, 0.5)).toBeNull(); expect(delta(null, 1)).toBeNull();
  });
  it('renders the gate verdict, reasons, metric rows and a no-longer-scored class', () => {
    const r = JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/daemon/score-draft.json'), 'utf8')) as ScoreResponse;
    const draft = { ...r, gate: { pass: false, reasons: ['dog recall 1.00→0.00'] }, draft: { ...r.draft, classes: Object.fromEntries(Object.entries(r.draft.classes).filter(([k]) => k !== 'dog')) } };
    render(<GateTable r={draft} />);
    expect(screen.getByTestId('gate-table')).toHaveAttribute('data-gate', 'fail');
    expect(screen.getByText('dog recall 1.00→0.00')).toBeInTheDocument();
    expect(screen.getByTestId('gate-row-horse_recall')).toBeInTheDocument();
    expect(screen.getByText('no longer scored')).toBeInTheDocument();
  });
});
