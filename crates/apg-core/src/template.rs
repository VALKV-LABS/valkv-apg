//! `{{ variable }}` templates (spec §9.5).
//!
//! Deliberately not a programming language: a variable, and one filter,
//! `default("…")`. No logic, loops or function calls. Templates are compiled
//! when configuration is applied, so a mistake is a validation error and never
//! a surprise at request time (spec TPL-1).

/// Variable roots a template may use.
pub const ROOTS: &[&str] = &["request", "client", "workspace", "consumer", "route", "service", "backend", "jwt", "env", "error"];

#[derive(Debug, Clone, PartialEq)]
enum Part {
    Literal(String),
    Variable { path: String, default: Option<String> },
}

/// A compiled template.
#[derive(Debug, Clone, PartialEq)]
pub struct Template {
    parts: Vec<Part>,
}

/// Why a template failed to compile.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum TemplateError {
    #[error("unclosed '{{{{' at offset {0}")]
    Unclosed(usize),
    #[error("empty placeholder at offset {0}")]
    Empty(usize),
    #[error("unknown variable '{0}'")]
    UnknownVariable(String),
    #[error("unsupported filter in '{0}'; only default(\"…\") is available")]
    BadFilter(String),
}

impl Template {
    /// Compiles a template, checking every placeholder.
    pub fn compile(source: &str) -> Result<Self, TemplateError> {
        let mut parts = Vec::new();
        let mut rest = source;
        let mut offset = 0;
        while let Some(start) = rest.find("{{") {
            if start > 0 {
                parts.push(Part::Literal(rest[..start].to_string()));
            }
            let after = &rest[start + 2..];
            let Some(end) = after.find("}}") else { return Err(TemplateError::Unclosed(offset + start)) };
            let inner = after[..end].trim();
            if inner.is_empty() {
                return Err(TemplateError::Empty(offset + start));
            }
            let (path, default) = match inner.split_once('|') {
                None => (inner, None),
                Some((path, filter)) => {
                    let filter = filter.trim();
                    let arg = filter
                        .strip_prefix("default(")
                        .and_then(|f| f.strip_suffix(')'))
                        .map(str::trim)
                        .and_then(|a| a.strip_prefix('"').and_then(|a| a.strip_suffix('"')).or_else(|| a.strip_prefix('\'').and_then(|a| a.strip_suffix('\''))))
                        .ok_or_else(|| TemplateError::BadFilter(inner.to_string()))?;
                    (path.trim(), Some(arg.to_string()))
                }
            };
            let root = path.split('.').next().unwrap_or("");
            let well_formed = path.split('.').all(|seg| !seg.is_empty() && seg.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'));
            if !ROOTS.contains(&root) || !well_formed || !path.contains('.') {
                return Err(TemplateError::UnknownVariable(path.to_string()));
            }
            parts.push(Part::Variable { path: path.to_string(), default });
            let consumed = start + 2 + end + 2;
            offset += consumed;
            rest = &rest[consumed..];
        }
        if !rest.is_empty() {
            parts.push(Part::Literal(rest.to_string()));
        }
        Ok(Self { parts })
    }

    /// Renders the template. `lookup` returns the value of a variable path, or
    /// `None` when it has no value for this request; that renders as the
    /// placeholder's default, or as nothing.
    pub fn render(&self, lookup: &dyn Fn(&str) -> Option<String>) -> String {
        let mut out = String::new();
        for part in &self.parts {
            match part {
                Part::Literal(s) => out.push_str(s),
                Part::Variable { path, default } => match lookup(path).filter(|v| !v.is_empty()) {
                    Some(v) => out.push_str(&v),
                    None => out.push_str(default.as_deref().unwrap_or("")),
                },
            }
        }
        out
    }

    /// True when the template has no placeholders.
    pub fn is_literal(&self) -> bool {
        self.parts.iter().all(|p| matches!(p, Part::Literal(_)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lookup(path: &str) -> Option<String> {
        match path {
            "request.id" => Some("req-1".into()),
            "workspace.slug" => Some("acme".into()),
            "consumer.name" => None,
            "request.header.x-empty" => Some(String::new()),
            _ => None,
        }
    }

    #[test]
    fn renders_variables_and_literals() {
        let t = Template::compile("<p>{{ request.id }}</p> for {{workspace.slug}}").unwrap();
        assert_eq!(t.render(&lookup), "<p>req-1</p> for acme");
        assert!(!t.is_literal());
        assert!(Template::compile("plain").unwrap().is_literal());
        assert_eq!(Template::compile("").unwrap().render(&lookup), "");
    }

    #[test]
    fn a_missing_or_empty_value_renders_as_the_default_or_nothing() {
        assert_eq!(Template::compile("[{{ consumer.name }}]").unwrap().render(&lookup), "[]");
        assert_eq!(Template::compile("[{{ consumer.name | default(\"anonymous\") }}]").unwrap().render(&lookup), "[anonymous]");
        assert_eq!(Template::compile("[{{ request.header.x-empty | default('none') }}]").unwrap().render(&lookup), "[none]");
    }

    // spec TPL-1: a mistake is caught when configuration is applied.
    #[test]
    fn mistakes_fail_at_compile_time() {
        assert_eq!(Template::compile("{{ request.id"), Err(TemplateError::Unclosed(0)));
        assert_eq!(Template::compile("a {{ }} b"), Err(TemplateError::Empty(2)));
        assert_eq!(Template::compile("{{ reqeust.id }}"), Err(TemplateError::UnknownVariable("reqeust.id".into())));
        assert_eq!(Template::compile("{{ request }}"), Err(TemplateError::UnknownVariable("request".into())));
        assert_eq!(Template::compile("{{ request..id }}"), Err(TemplateError::UnknownVariable("request..id".into())));
        assert!(matches!(Template::compile("{{ request.id | upper }}"), Err(TemplateError::BadFilter(_))));
        assert!(matches!(Template::compile("{{ request.id | default(x) }}"), Err(TemplateError::BadFilter(_))));
    }

    // No way to smuggle logic or reach outside the variable set.
    #[test]
    fn there_is_no_expression_language() {
        for src in ["{{ 1 + 1 }}", "{{ env }}", "{{ system.exit }}", "{{ request.id; drop }}", "{% if x %}"] {
            let r = Template::compile(src);
            assert!(r.is_err() || r.unwrap().is_literal(), "{src}");
        }
    }
}
