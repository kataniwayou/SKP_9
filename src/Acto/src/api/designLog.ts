/** An Output line's weight: an error line is drawn red. */
export type OutputLevel = 'info' | 'error';

/** One line of BaseApi's own account of a design save (`DesignOutcomeDto.log`). */
export interface DesignLogLine {
  stage: string; level: OutputLevel; kind: string; id: string | null; message: string;
  /** A change the dry run made and its rollback undid (BaseApi's `rolledBack`). */
  rolledBack?: boolean;
}
