export default function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy("site/style.css");
  eleventyConfig.addPassthroughCopy("site/CNAME");

  eleventyConfig.addFilter("readableDate", (value) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date);
  });

  return {
    pathPrefix: "/",
    dir: {
      input: "site",
      output: "site/_site",
      includes: "_includes"
    }
  };
}
