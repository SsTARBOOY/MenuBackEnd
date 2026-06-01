import { Router } from "express";

export const googleReviewsRouter = Router();

interface GooglePlaceReview {
  author_name?: string;
  profile_photo_url?: string;
  rating?: number;
  relative_time_description?: string;
  text?: string;
  time?: number;
}

interface GooglePlaceDetailsResponse {
  status: string;
  error_message?: string;
  result?: {
    name?: string;
    rating?: number;
    user_ratings_total?: number;
    url?: string;
    reviews?: GooglePlaceReview[];
  };
}

googleReviewsRouter.get("/google-reviews", async (_req, res) => {
  try {
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;

    const places = [
      {
        branch: "Guerrero",
        placeId: process.env.GOOGLE_PLACE_ID_GUERRERO,
      },
      {
        branch: "Madero",
        placeId: process.env.GOOGLE_PLACE_ID_MADERO,
      },
    ].filter((place) => Boolean(place.placeId));

    if (!apiKey) {
      return res.status(500).json({
        ok: false,
        error: "Falta GOOGLE_PLACES_API_KEY en el .env",
      });
    }

    if (places.length === 0) {
      return res.status(500).json({
        ok: false,
        error: "Faltan GOOGLE_PLACE_ID_GUERRERO y GOOGLE_PLACE_ID_MADERO en el .env",
      });
    }

    const results = await Promise.all(
      places.map(async ({ branch, placeId }) => {
        const params = new URLSearchParams({
          place_id: String(placeId),
          fields: "name,rating,user_ratings_total,reviews,url",
          language: "es",
          key: apiKey,
        });

        const response = await fetch(
          `https://maps.googleapis.com/maps/api/place/details/json?${params.toString()}`
        );

        const data = (await response.json()) as GooglePlaceDetailsResponse;

        if (data.status !== "OK" || !data.result) {
          return {
            branch,
            ok: false,
            error: data.error_message || data.status,
            name: "",
            rating: 0,
            userRatingsTotal: 0,
            googleUrl: "",
            reviews: [],
          };
        }

        return {
          branch,
          ok: true,
          name: data.result.name || "",
          rating: data.result.rating || 0,
          userRatingsTotal: data.result.user_ratings_total || 0,
          googleUrl: data.result.url || "",
          reviews: Array.isArray(data.result.reviews)
            ? data.result.reviews.map((review) => ({
                authorName: review.author_name || "Cliente de Google",
                profilePhotoUrl: review.profile_photo_url || "",
                rating: review.rating || 0,
                relativeTimeDescription: review.relative_time_description || "",
                text: review.text || "",
                time: review.time || 0,
              }))
            : [],
        };
      })
    );

    const reviews = results.flatMap((place) =>
      place.reviews.map((review) => ({
        ...review,
        branch: place.branch,
        googleUrl: place.googleUrl,
      }))
    );

    const totalRatings = results.reduce(
      (sum, place) => sum + Number(place.userRatingsTotal || 0),
      0
    );

    const weightedRating =
      totalRatings > 0
        ? results.reduce(
            (sum, place) =>
              sum + Number(place.rating || 0) * Number(place.userRatingsTotal || 0),
            0
          ) / totalRatings
        : 0;

    return res.json({
      ok: true,
      rating: Math.round(weightedRating * 10) / 10,
      userRatingsTotal: totalRatings,
      places: results,
      reviews,
    });
  } catch (error) {
    console.error("Error en /api/google-reviews:", error);

    return res.status(500).json({
      ok: false,
      error: "No se pudieron obtener las reseñas de Google",
    });
  }
});