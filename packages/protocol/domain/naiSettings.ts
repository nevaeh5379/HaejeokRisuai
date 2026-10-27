export interface NAISettings {
  topK: number;
  topP: number;
  topA: number;
  tailFreeSampling: number;
  repetitionPenalty: number;
  repetitionPenaltyRange: number;
  repetitionPenaltySlope: number;
  repostitionPenaltyPresence: number;
  seperator: string;
  frequencyPenalty: number;
  presencePenalty: number;
  typicalp: number;
  starter: string;
  mirostat_lr?: number;
  mirostat_tau?: number;
  cfg_scale?: number;
}
