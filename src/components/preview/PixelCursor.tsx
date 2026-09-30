/**
 * The 1-bit arrow pointer from early desktops, drawn on an 11×17 pixel grid (crisp edges). Used by the hero
 * demonstration as the moving cursor, and by How it works as the arrow between steps.
 */
export function PixelCursor({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg className={className} style={style} viewBox="0 0 11 17" shapeRendering="crispEdges" aria-hidden="true">
      <path d="M0 0h1v1H0zM0 1h2v1H0zM0 2h1v1H0zM2 2h1v1H2zM0 3h1v1H0zM3 3h1v1H3zM0 4h1v1H0zM4 4h1v1H4zM0 5h1v1H0zM5 5h1v1H5zM0 6h1v1H0zM6 6h1v1H6zM0 7h1v1H0zM7 7h1v1H7zM0 8h1v1H0zM8 8h1v1H8zM0 9h1v1H0zM9 9h1v1H9zM0 10h1v1H0zM6 10h5v1H6zM0 11h1v1H0zM3 11h1v1H3zM6 11h1v1H6zM0 12h1v1H0zM2 12h1v1H2zM4 12h1v1H4zM7 12h1v1H7zM0 13h2v1H0zM4 13h1v1H4zM7 13h1v1H7zM0 14h1v1H0zM5 14h1v1H5zM8 14h1v1H8zM5 15h1v1H5zM8 15h1v1H8zM6 16h2v1H6z" fill="#000" />
      <path d="M1 2h1v1H1zM1 3h2v1H1zM1 4h3v1H1zM1 5h4v1H1zM1 6h5v1H1zM1 7h6v1H1zM1 8h7v1H1zM1 9h8v1H1zM1 10h5v1H1zM1 11h2v1H1zM4 11h2v1H4zM1 12h1v1H1zM5 12h2v1H5zM5 13h2v1H5zM6 14h2v1H6zM6 15h2v1H6z" fill="#fff" />
    </svg>
  );
}
