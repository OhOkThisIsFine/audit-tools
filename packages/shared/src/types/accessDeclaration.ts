export interface AccessDeclaration {
  read_paths: string[];
  write_paths: string[];
  forbidden_patterns?: string[];
}
