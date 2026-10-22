// Preserve legacy precedence until the user explicitly selects a search mode.
export function getSearchMode(settings) {
    if (settings.get_user_value('search-mode') !== null)
        return settings.get_int('search-mode');
    return settings.get_boolean('regex-search') ? 2 : settings.get_boolean('semantic-search') ? 1 : 0;
}
export const SEARCH_MODES = ['Keyword', 'Hybrid', 'Regular expression'];
