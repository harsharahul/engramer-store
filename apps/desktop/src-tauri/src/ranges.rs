//! HTTP byte-range parsing, shared by every native protocol that answers
//! a media element: the decrypting stream:// path and the picked-file
//! serving path. One parser, so the two can never disagree about what a
//! Range header means.

/// Interprets a Range header against a resource of `size` bytes, returning
/// the inclusive byte span to answer. `max_open_window` bounds an
/// open-ended request ("bytes=N-"): the player follows up for the rest.
/// None means the request is unanswerable (416 territory) or absent.
pub fn parse_range(header: Option<&str>, size: u64, max_open_window: u64) -> Option<(u64, u64)> {
    let header = header?.trim();
    let rest = header.strip_prefix("bytes=")?;
    let (from, to) = rest.split_once('-')?;
    if from.is_empty() {
        let suffix: u64 = to.parse().ok()?;
        if suffix == 0 {
            return None;
        }
        return Some((size.saturating_sub(suffix), size - 1));
    }
    let start: u64 = from.parse().ok()?;
    let end: u64 = if to.is_empty() {
        (start + max_open_window - 1).min(size - 1)
    } else {
        to.parse::<u64>().ok()?.min(size - 1)
    };
    if start >= size || start > end {
        return None;
    }
    Some((start, end))
}

#[cfg(test)]
mod tests {
    use super::parse_range;

    const WINDOW: u64 = 16 * 1024 * 1024;

    #[test]
    fn absent_header_means_no_range() {
        assert_eq!(parse_range(None, 100, WINDOW), None);
    }

    #[test]
    fn a_closed_range_is_taken_as_written() {
        assert_eq!(parse_range(Some("bytes=2-7"), 100, WINDOW), Some((2, 7)));
    }

    #[test]
    fn an_end_past_the_resource_clamps() {
        assert_eq!(parse_range(Some("bytes=90-500"), 100, WINDOW), Some((90, 99)));
    }

    #[test]
    fn an_open_range_answers_a_bounded_window() {
        assert_eq!(parse_range(Some("bytes=0-"), 100, WINDOW), Some((0, 99)));
        let big = 100 * 1024 * 1024;
        assert_eq!(parse_range(Some("bytes=0-"), big, WINDOW), Some((0, WINDOW - 1)));
    }

    #[test]
    fn a_suffix_range_takes_the_tail() {
        assert_eq!(parse_range(Some("bytes=-10"), 100, WINDOW), Some((90, 99)));
        assert_eq!(parse_range(Some("bytes=-0"), 100, WINDOW), None);
    }

    #[test]
    fn a_start_past_the_end_is_unanswerable() {
        assert_eq!(parse_range(Some("bytes=100-"), 100, WINDOW), None);
        assert_eq!(parse_range(Some("bytes=7-2"), 100, WINDOW), None);
    }

    #[test]
    fn junk_reads_as_no_range() {
        assert_eq!(parse_range(Some("chunks=1-2"), 100, WINDOW), None);
        assert_eq!(parse_range(Some("bytes=a-b"), 100, WINDOW), None);
    }
}
