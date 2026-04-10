// HTML processing module

use regex::Regex;

pub fn html_to_markdown(html: &str) -> String {
    let mut text = html.to_string();

    // Line breaks
    text = Regex::new(r"<br\s*/?>").unwrap().replace_all(&text, "\n").to_string();
    // Paragraphs
    text = text.replace("</p>", "\n\n");
    // List items
    text = text.replace("</li>", "\n");
    text = text.replace("<li>", "- ");
    // Headings → markdown h3
    text = Regex::new(r"<h[1-6][^>]*>").unwrap().replace_all(&text, "\n### ").to_string();
    text = Regex::new(r"</h[1-6]>").unwrap().replace_all(&text, "\n").to_string();
    // Links
    text = Regex::new(r#"<a[^>]*href="([^"]*)"[^>]*>([^<]*)</a>"#).unwrap()
        .replace_all(&text, "[$2]($1)").to_string();
    // Inline code
    text = Regex::new(r"<code>([^<]*)</code>").unwrap()
        .replace_all(&text, "`$1`").to_string();
    // Strip all remaining HTML tags
    text = Regex::new(r"<[^>]+>").unwrap().replace_all(&text, "").to_string();
    // HTML entities
    text = text.replace("&amp;", "&");
    text = text.replace("&lt;", "<");
    text = text.replace("&gt;", ">");
    text = text.replace("&quot;", "\"");
    text = text.replace("&#39;", "'");
    // Collapse excessive newlines
    text = Regex::new(r"\n{3,}").unwrap().replace_all(&text, "\n\n").to_string();

    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_br_tags() {
        assert_eq!(html_to_markdown("line1<br>line2<br/>line3"), "line1\nline2\nline3");
    }

    #[test]
    fn test_paragraphs() {
        assert_eq!(html_to_markdown("<p>para1</p><p>para2</p>"), "para1\n\npara2\n\n");
    }

    #[test]
    fn test_links() {
        assert_eq!(
            html_to_markdown(r#"<a href="https://example.com">click</a>"#),
            "[click](https://example.com)"
        );
    }

    #[test]
    fn test_inline_code() {
        assert_eq!(html_to_markdown("<code>foo()</code>"), "`foo()`");
    }

    #[test]
    fn test_headings() {
        assert_eq!(html_to_markdown("<h2>Title</h2>"), "\n### Title\n");
    }

    #[test]
    fn test_list_items() {
        assert_eq!(html_to_markdown("<li>one</li><li>two</li>"), "- one\n- two\n");
    }

    #[test]
    fn test_strips_remaining_tags() {
        assert_eq!(html_to_markdown("<div><span>text</span></div>"), "text");
    }

    #[test]
    fn test_html_entities() {
        assert_eq!(html_to_markdown("a &amp; b &lt; c &gt; d"), "a & b < c > d");
    }

    #[test]
    fn test_collapses_newlines() {
        assert_eq!(html_to_markdown("a\n\n\n\nb"), "a\n\nb");
    }
}
