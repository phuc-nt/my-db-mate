import { describe, it, expect } from 'vitest';
import { normalizePinnedDatasets, withValidatedPinnedDatasets } from './pinned-dataset-config';

/**
 * Pinned dataset names travel from a text box into a table reference the query
 * builders emit into real SQL, so the shape is enforced at the write boundary
 * rather than sanitized on the way out.
 */
describe('normalizePinnedDatasets', () => {
  it('accepts project.dataset with BigQuery\'s legal charset', () => {
    expect(normalizePinnedDatasets(['bigquery-public-data.thelook_ecommerce'])).toEqual([
      'bigquery-public-data.thelook_ecommerce',
    ]);
    expect(normalizePinnedDatasets(['proj123.ds_2024'])).toEqual(['proj123.ds_2024']);
  });

  it('trims, drops blanks, and de-duplicates', () => {
    expect(normalizePinnedDatasets(['  a-1.b  ', '', '   ', 'a-1.b'])).toEqual(['a-1.b']);
  });

  it('returns undefined when nothing is pinned, so the key stays out of config', () => {
    expect(normalizePinnedDatasets(undefined)).toBeUndefined();
    expect(normalizePinnedDatasets(null)).toBeUndefined();
    expect(normalizePinnedDatasets([])).toBeUndefined();
    expect(normalizePinnedDatasets(['  '])).toBeUndefined();
  });

  it.each([
    ['a bare dataset with no project', 'thelook_ecommerce'],
    ['a fully-qualified table, which would sync nothing', 'proj.ds.orders'],
    ['backticks', '`proj`.`ds`'],
    ['whitespace inside the name', 'proj.my dataset'],
    ['a quote that would break out of the identifier', "proj.ds`; DROP"],
    ['an underscore in the project half only being legal in the dataset half', 'proj.ds-hyphen'],
    ['an empty half', 'proj.'],
  ])('rejects %s', (_label, input) => {
    expect(() => normalizePinnedDatasets([input])).toThrow(/Invalid external dataset/);
  });

  it('rejects a non-array outright rather than coercing it', () => {
    expect(() => normalizePinnedDatasets('bigquery-public-data.thelook_ecommerce')).toThrow(
      /Invalid external dataset/,
    );
  });
});

describe('withValidatedPinnedDatasets', () => {
  it('keeps the validated list on a BigQuery config', () => {
    const out = withValidatedPinnedDatasets('bigquery-driver', {
      projectId: 'p',
      extraDatasets: ['bigquery-public-data.thelook_ecommerce'],
    });
    expect(out).toEqual({ projectId: 'p', extraDatasets: ['bigquery-public-data.thelook_ecommerce'] });
  });

  it('drops the key entirely for a dialect with no catalog level to resolve it against', () => {
    const out = withValidatedPinnedDatasets('tcp-driver', { host: 'db', extraDatasets: ['anything at all'] });
    expect(out).toEqual({ host: 'db' });
  });

  it('leaves a config that never mentioned the key untouched', () => {
    const config = { projectId: 'p' };
    expect(withValidatedPinnedDatasets('bigquery-driver', config)).toBe(config);
  });

  it('drops an empty list rather than storing an empty array', () => {
    expect(withValidatedPinnedDatasets('bigquery-driver', { projectId: 'p', extraDatasets: [] })).toEqual({
      projectId: 'p',
    });
  });

  it('rejects a malformed entry on a BigQuery config', () => {
    expect(() =>
      withValidatedPinnedDatasets('bigquery-driver', { projectId: 'p', extraDatasets: ['proj.ds.orders'] }),
    ).toThrow(/Invalid external dataset/);
  });
});
