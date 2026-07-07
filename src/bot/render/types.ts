export interface RenderResult {
  text: string;
  entities: MessageEntity[];
}

export interface MessageEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  language?: string;
}
