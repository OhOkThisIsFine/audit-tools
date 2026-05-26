export interface RiskItem {
  unit_id: string;
  risk_score: number;
  signals: string[];
  notes?: string[];
}

export interface RiskRegister {
  items: RiskItem[];
}
