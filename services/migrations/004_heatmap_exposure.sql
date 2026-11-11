-- The heatmap keeps each borrower's risk-weighted NEAR exposure and its value-weighted volatility
-- ratios, so cascades size liquidations the way Rhea lending allows them (back to health 1).

ALTER TABLE heatmap_accounts ADD COLUMN IF NOT EXISTS exposure DOUBLE PRECISION;
ALTER TABLE heatmap_accounts ADD COLUMN IF NOT EXISTS collateral_ratio DOUBLE PRECISION;
ALTER TABLE heatmap_accounts ADD COLUMN IF NOT EXISTS debt_ratio DOUBLE PRECISION;
